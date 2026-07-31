"""Unified-diff parser (report §7.2 step 01, §3.1 step 05).

Parses a raw GitHub PR diff into per-file, per-hunk structures with precise
line-number metadata. Downstream consumers:

- BASE-6 (RAG retrieval) embeds the output of ``chunk_text``.
- BASE-7 (LLM chain) uses ``map_position_to_file_line`` to anchor review
  comments to real file line numbers.
"""

import re
from dataclasses import dataclass, field
from enum import Enum


class LineKind(str, Enum):
    added = "added"
    removed = "removed"
    context = "context"


class FileStatus(str, Enum):
    added = "added"
    modified = "modified"
    deleted = "deleted"
    renamed = "renamed"


@dataclass
class DiffLine:
    kind: LineKind
    content: str  # without the leading +/-/space marker
    old_lineno: int | None  # None for added lines
    new_lineno: int | None  # None for removed lines


@dataclass
class DiffHunk:
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    section: str  # text after the second @@, often the enclosing function
    lines: list[DiffLine] = field(default_factory=list)

    @property
    def new_line_range(self) -> tuple[int, int]:
        """(start, end) line numbers of this hunk in the new file."""
        end = max(self.new_start + self.new_count - 1, self.new_start)
        return (self.new_start, end)


@dataclass
class FileDiff:
    old_path: str
    new_path: str
    status: FileStatus
    is_binary: bool = False
    hunks: list[DiffHunk] = field(default_factory=list)

    @property
    def path(self) -> str:
        """Canonical path: the new path unless the file was deleted."""
        return self.old_path if self.status == FileStatus.deleted else self.new_path


_DIFF_GIT_RE = re.compile(r'^diff --git (?:"?a/(?P<a>.*?)"?) (?:"?b/(?P<b>.*?)"?)$')
_HUNK_HEADER_RE = re.compile(
    r"^@@ -(?P<old_start>\d+)(?:,(?P<old_count>\d+))? "
    r"\+(?P<new_start>\d+)(?:,(?P<new_count>\d+))? @@(?P<section> .*)?$"
)


def parse_diff(raw: str) -> list[FileDiff]:
    """Parse a raw unified diff (GitHub PR format) into ``FileDiff`` entries."""
    files: list[FileDiff] = []
    current: FileDiff | None = None
    hunk: DiffHunk | None = None
    old_no = new_no = 0

    for line in raw.splitlines():
        m = _DIFF_GIT_RE.match(line)
        if m:
            current = FileDiff(old_path=m.group("a"), new_path=m.group("b"), status=FileStatus.modified)
            files.append(current)
            hunk = None
            continue

        if current is None:
            continue  # preamble before the first diff --git

        if hunk is None:
            # File-level metadata lines between "diff --git" and the first hunk.
            if line.startswith("new file"):
                current.status = FileStatus.added
                continue
            if line.startswith("deleted file"):
                current.status = FileStatus.deleted
                continue
            if line.startswith("rename from ") or line.startswith("rename to "):
                current.status = FileStatus.renamed
                continue
            if line.startswith("Binary files"):
                current.is_binary = True
                continue

        m = _HUNK_HEADER_RE.match(line)
        if m:
            hunk = DiffHunk(
                old_start=int(m.group("old_start")),
                old_count=int(m.group("old_count") or 1),
                new_start=int(m.group("new_start")),
                new_count=int(m.group("new_count") or 1),
                section=(m.group("section") or "").strip(),
            )
            current.hunks.append(hunk)
            old_no = hunk.old_start
            new_no = hunk.new_start
            continue

        if hunk is None:
            continue  # other metadata (index, mode, --- / +++ headers)

        if line.startswith("\\"):
            continue  # "\ No newline at end of file"
        if line.startswith("+"):
            hunk.lines.append(DiffLine(LineKind.added, line[1:], None, new_no))
            new_no += 1
        elif line.startswith("-"):
            hunk.lines.append(DiffLine(LineKind.removed, line[1:], old_no, None))
            old_no += 1
        elif line.startswith(" ") or line == "":
            hunk.lines.append(DiffLine(LineKind.context, line[1:], old_no, new_no))
            old_no += 1
            new_no += 1
        # anything else (e.g. "--- a/x", "+++ b/x" inside a malformed hunk) is skipped

    return files


def map_position_to_file_line(file_diff: FileDiff, position: int) -> int | None:
    """Map a 1-based diff position (GitHub review style: counted over hunk
    headers and body lines, per file) to a line number in the new file.

    Removed lines have no new-file line and return ``None``.
    """
    pos = 0
    for hunk in file_diff.hunks:
        pos += 1  # the @@ header itself counts as a position
        for dline in hunk.lines:
            pos += 1
            if pos == position:
                return dline.new_lineno
    return None


def chunk_text(file_diff: FileDiff) -> list[str]:
    """Render each hunk as an annotated text block for embedding (BASE-6).

    Header carries the file path and new-file line range so retrieval hits
    can be traced back to a location.

    **This is embedding input, not prompt input.** ``rag_service`` embeds the
    result verbatim as the retrieval query, so the text here is part of what
    decides which chunks come back. Use ``numbered_chunk_text`` for anything
    the model reads; changing this function changes retrieval.
    """
    chunks: list[str] = []
    for hunk in file_diff.hunks:
        start, end = hunk.new_line_range
        header = f"# {file_diff.path} lines {start}-{end}"
        if hunk.section:
            header += f" ({hunk.section})"
        body = "\n".join(
            {"added": "+", "removed": "-", "context": " "}[dl.kind.value] + dl.content
            for dl in hunk.lines
        )
        chunks.append(f"{header}\n{body}")
    return chunks


def numbered_chunk_text(file_diff: FileDiff) -> list[str]:
    """Render each hunk for the *review prompt*, with the new-file line number
    stamped in a left gutter on every line.

    Same content as ``chunk_text``; the difference is that the line number the
    model has to put in ``line_start``/``line_end`` is printed rather than
    implied. Without the gutter the model is given only the hunk's start line
    and has to walk the body counting ``+`` and context lines while skipping
    ``-`` lines — and #227 measured what that costs: on PR #58 every comment
    was factually correct and every line number was wrong, off by 12 to 27 in
    both directions.

    That PR is also why this is a rendering fix rather than a prompt-wording
    one. ``setup-mac.sh`` there is a *new* file — one hunk, all 186 lines
    added, no removed or context lines at all — so new-file line N sits at
    body position N with no old/new divergence to get wrong, and the header
    (``lines 1-186``) was correct. The only remaining step was counting to
    186, and the model returned 68 for a finding about lines 40-42. #202 had
    already shown that two different wordings of "use the NEW-file line
    numbers" moved nothing. Printing the number removes the arithmetic
    instead of asking for it again.

    Removed lines get a blank gutter: they do not exist in the new file, so
    there is no number to print and nothing there to comment on.

    Kept separate from ``chunk_text`` deliberately — that one is embedded as
    the RAG query, and numbering it would change retrieval, which is a second
    variable in exactly the comparison #227 has to make against the committed
    ``docs/prompt-eval`` artifacts.
    """
    chunks: list[str] = []
    for hunk in file_diff.hunks:
        start, end = hunk.new_line_range
        header = f"# {file_diff.path} lines {start}-{end}"
        if hunk.section:
            header += f" ({hunk.section})"
        # Width from the largest number actually rendered, so the gutter stays
        # narrow on small hunks and still aligns on a 4-digit file.
        width = len(str(max(end, start)))
        body_lines: list[str] = []
        for dl in hunk.lines:
            marker = {"added": "+", "removed": "-", "context": " "}[dl.kind.value]
            gutter = f"{dl.new_lineno:>{width}}" if dl.new_lineno is not None else " " * width
            body_lines.append(f"{gutter} {marker}{dl.content}")
        chunks.append("\n".join([header, *body_lines]))
    return chunks
