"""Turning a stored Liffy review into a GitHub review payload (report §6, §3.1 step 12).

Everything here is a **pure function** over plain values: no client, no
session, no network. That is deliberate — the interesting behaviour in GH-2 is
the mapping and the filtering, and both are far easier to be confident about
when a test can call them directly. ``review_service`` does the I/O.
"""

from dataclasses import dataclass

from app.models.review_comment import ReviewComment
from app.services.diff_parser import FileDiff
from app.services.github_service import is_line_commentable, is_span_commentable

# Liffy's verdicts map one-to-one onto GitHub's review events, and the mapping
# is still not a straight lookup — see ``resolve_event``.
_NATIVE_EVENT = {
    "approve": "APPROVE",
    "request_changes": "REQUEST_CHANGES",
}

EVENT_MODE_NATIVE = "native"
EVENT_MODE_COMMENT_ONLY = "comment_only"

# GitHub's validation bodies run long, and `reviews.post_error` is a String
# column. Truncating at the boundary keeps the useful head of the message —
# GitHub puts the offending field first.
MAX_POST_ERROR_CHARS = 1000


@dataclass(frozen=True)
class ReviewEvent:
    """A GitHub review event, and why it might not be the verdict's own."""

    event: str
    # Set when the event is *not* the direct translation of the verdict. It
    # goes into the posted body: silently posting COMMENT when the verdict was
    # request_changes misrepresents the review to the person reading it.
    downgrade_note: str | None = None


def resolve_event(verdict: str | None, *, is_own_pr: bool, mode: str) -> ReviewEvent:
    """Which GitHub event to send, and whether to explain it.

    Three reasons the answer is not simply ``_NATIVE_EVENT[verdict]``:

    **A failed review has no verdict.** ``verdict`` is NULL on failure, and a
    review with nothing to say is a ``COMMENT``.

    **GitHub returns 422 for approving or requesting changes on your own pull
    request.** Verified live against the API:

        APPROVE          -> ["Review Can not approve your own pull request"]
        REQUEST_CHANGES  -> ["Review Can not request changes on your own pull request"]

    On this project that is the *normal* case — Liffy reviews a repository
    whose PR author and token owner are usually the same person — so it is the
    common path, not an edge case.

    **``request_changes`` on somebody else's PR genuinely blocks their merge.**
    An AI tool that blocks a human's merge by default is the kind of default
    people uninstall over, so it is opt-in via ``mode="native"``.
    """
    native = _NATIVE_EVENT.get(verdict or "")
    if native is None:
        return ReviewEvent("COMMENT")

    spoken = (verdict or "").replace("_", " ")

    if is_own_pr:
        return ReviewEvent(
            "COMMENT",
            f"Liffy would **{spoken}** here, but GitHub does not allow a review "
            "event on your own pull request — so this is posted as a comment.",
        )

    if mode != EVENT_MODE_NATIVE:
        return ReviewEvent(
            "COMMENT",
            f"Liffy's verdict is **{spoken}**. Posted as a comment because "
            "`github_review_event_mode` is `comment_only`.",
        )

    return ReviewEvent(native)


def _comment_body(comment: ReviewComment) -> str:
    """One Liffy comment, rendered for GitHub.

    Severity and category lead, because they are the triage signal and GitHub
    has nowhere else to put them — the dashboard shows them as badges.
    """
    head = f"**{comment.severity}** · `{comment.category}`"
    body = f"{head}\n\n{comment.comment_text}"
    if comment.suggestion:
        body += f"\n\n```suggestion\n{comment.suggestion}\n```"
    return body


def partition_comments(
    comments: list[ReviewComment], file_diffs: list[FileDiff]
) -> tuple[list[dict], list[ReviewComment]]:
    """Split comments into ``(postable_inline, unanchorable)``.

    **One invalid line 422s the entire review**, so every comment is checked
    against the parsed diff before the call rather than after the failure.

    Multi-line spans degrade rather than drop: GitHub needs both ends in the
    same hunk, and when they are not, the comment is posted as a single-line
    comment on ``line_end``. Losing the multi-line highlight is a much smaller
    loss than losing the finding.
    """
    postable: list[dict] = []
    unanchorable: list[ReviewComment] = []

    for comment in comments:
        body = _comment_body(comment)
        spans = comment.line_end > comment.line_start

        if spans and is_span_commentable(
            file_diffs, comment.file_path, comment.line_start, comment.line_end
        ):
            postable.append(
                {
                    "path": comment.file_path,
                    "start_line": comment.line_start,
                    "line": comment.line_end,
                    "side": "RIGHT",
                    "body": body,
                }
            )
        elif is_line_commentable(file_diffs, comment.file_path, comment.line_end):
            postable.append(
                {
                    "path": comment.file_path,
                    "line": comment.line_end,
                    "side": "RIGHT",
                    "body": body,
                }
            )
        else:
            unanchorable.append(comment)

    return postable, unanchorable


def _overview(
    summary: str | None,
    changes: list[str],
    files: list[tuple[str, str]],
    comment_count: int,
) -> str:
    """The part a reader meets before any finding.

    Shaped as a briefing rather than a paragraph: what this pull request does,
    then what changed where, then how much Liffy had to say about it. A wall of
    prose is skimmed; a heading, a short list and a table are read.

    Every section is optional. A model that returned only the prose summary —
    the older output shape, or a small local model that ignored half the schema
    — still produces a sensible body here rather than a page of empty headings.
    """
    parts = [
        "## Pull request overview",
        summary or "_Liffy produced no summary for this review._",
    ]

    if changes:
        parts.append("**Changes:**\n" + "\n".join(f"- {c}" for c in changes))

    if files:
        # Pipes inside a cell would break the table; a path or a sentence
        # containing one is unusual but not impossible.
        def cell(text: str) -> str:
            return text.replace("|", r"\|")

        rows = "\n".join(f"| `{cell(path)}` | {cell(note)} |" for path, note in files)
        parts.append(
            "### Reviewed changes\n\n"
            f"Liffy read {len(files)} changed file{'' if len(files) == 1 else 's'} "
            f"and left {comment_count} comment{'' if comment_count == 1 else 's'}.\n\n"
            "| File | Description |\n| --- | --- |\n" + rows
        )
    elif comment_count:
        parts.append(
            f"Liffy left {comment_count} comment{'' if comment_count == 1 else 's'}."
        )

    return "\n\n".join(parts)


def build_review_body(
    summary: str | None,
    *,
    event: ReviewEvent,
    unanchorable: list[ReviewComment],
    supersedes_url: str | None = None,
    changes: list[str] | None = None,
    files: list[tuple[str, str]] | None = None,
    comment_count: int = 0,
) -> str:
    """The review's top-level body.

    Carries three things the inline comments cannot:

    - the overview — what the pull request does, what changed where
    - why the event is not the verdict, when it is not
    - **the findings that could not be anchored**, as a plain-text appendix.
      Dropping them silently loses real findings; a comment on a line GitHub
      will not accept is still a comment worth reading.
    """
    parts: list[str] = [
        _overview(summary, changes or [], files or [], comment_count)
    ]

    if event.downgrade_note:
        parts.append(event.downgrade_note)

    if unanchorable:
        lines = "\n".join(
            f"- `{c.file_path}:{c.line_start}` — **{c.severity}** · `{c.category}` — "
            f"{c.comment_text}"
            for c in unanchorable
        )
        parts.append(
            "<details>\n<summary>"
            f"{len(unanchorable)} comment(s) could not be anchored to a diff line"
            "</summary>\n\n"
            "GitHub only accepts inline comments on lines that appear in the "
            "diff, so these are reproduced here rather than dropped.\n\n"
            f"{lines}\n</details>"
        )

    if supersedes_url:
        parts.append(
            f"_Supersedes Liffy's earlier review on this pull request: {supersedes_url}_"
        )

    return "\n\n---\n\n".join(parts)


def truncate_post_error(message: str) -> str:
    """GitHub's body, cut to fit ``reviews.post_error``."""
    if len(message) <= MAX_POST_ERROR_CHARS:
        return message
    return message[: MAX_POST_ERROR_CHARS - 1] + "…"
