/**
 * Unified-diff parser, mirroring `backend/app/services/diff_parser.py`.
 *
 * The two have to agree: the backend maps review comments onto new-file line
 * numbers with its parser, and this one maps those same line numbers back
 * onto rendered rows. A disagreement about, say, whether an omitted hunk
 * count defaults to 1 puts every comment in a file on the wrong line.
 *
 * Kept deliberately close to the Python, including which lines are ignored.
 */

export type LineKind = "added" | "removed" | "context";
export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffLine {
  kind: LineKind;
  /** Without the leading +/-/space marker. */
  content: string;
  /** null on added lines — they do not exist in the old file. */
  oldLineNo: number | null;
  /** null on removed lines — they do not exist in the new file. */
  newLineNo: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Text after the second @@ — usually the enclosing function. */
  section: string;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  /** The new path, unless the file was deleted. Matches FileDiff.path. */
  path: string;
  status: FileStatus;
  isBinary: boolean;
  hunks: DiffHunk[];
}

const DIFF_GIT_RE = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/;
const HUNK_HEADER_RE =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;

/**
 * Python's `splitlines()`, which is what the backend parser iterates.
 * `raw.split("\n")` differs in exactly one way that matters: on a diff ending
 * with a newline — i.e. every real diff — it yields a trailing "", and this
 * parser reads "" as an empty context line. That would append a phantom line
 * to the last hunk of every file.
 */
function splitLines(raw: string): string[] {
  const lines = raw.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function parseDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of splitLines(raw)) {
    const fileMatch = DIFF_GIT_RE.exec(line);
    if (fileMatch) {
      current = {
        oldPath: fileMatch[1],
        newPath: fileMatch[2],
        path: fileMatch[2],
        status: "modified",
        isBinary: false,
        hunks: [],
      };
      files.push(current);
      hunk = null;
      continue;
    }

    if (!current) continue; // preamble before the first `diff --git`

    if (!hunk) {
      // File-level metadata, between `diff --git` and the first hunk.
      if (line.startsWith("new file")) {
        current.status = "added";
        continue;
      }
      if (line.startsWith("deleted file")) {
        current.status = "deleted";
        current.path = current.oldPath;
        continue;
      }
      if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
        current.status = "renamed";
        continue;
      }
      if (line.startsWith("Binary files")) {
        current.isBinary = true;
        continue;
      }
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      hunk = {
        oldStart: Number(hunkMatch[1]),
        // An omitted count means 1, not 0. Reading it as 0 (or NaN) desyncs
        // every line number after the first single-line hunk.
        oldCount: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newCount: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        section: (hunkMatch[5] ?? "").trim(),
        lines: [],
      };
      current.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }

    if (!hunk) continue; // index / mode / --- / +++ headers

    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    if (line.startsWith("+")) {
      hunk.lines.push({
        kind: "added",
        content: line.slice(1),
        oldLineNo: null,
        newLineNo: newNo,
      });
      newNo += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({
        kind: "removed",
        content: line.slice(1),
        oldLineNo: oldNo,
        newLineNo: null,
      });
      oldNo += 1;
    } else if (line.startsWith(" ") || line === "") {
      hunk.lines.push({
        kind: "context",
        content: line.slice(1),
        oldLineNo: oldNo,
        newLineNo: newNo,
      });
      oldNo += 1;
      newNo += 1;
    }
    // Anything else (a stray "--- a/x" inside a malformed hunk) is skipped,
    // same as the Python.
  }

  return files;
}

/* ── Rendering ─────────────────────────────────────────────────────────── */

export type RenderedRow =
  | { kind: "hunk"; text: string; oldLineNo: null; newLineNo: null }
  | {
      kind: LineKind;
      text: string;
      oldLineNo: number | null;
      newLineNo: number | null;
    };

export interface RenderedDiff {
  /** Editor content. Row N of `rows` is line N+1 of this text. */
  text: string;
  rows: RenderedRow[];
}

/**
 * Flattens a file's hunks into the rows an editor actually shows: every hunk
 * body, each preceded by its @@ header as a separator row.
 *
 * No blank padding to line the two sides up. A unified diff is not two files,
 * and padding is what forces the line numbers to be fabricated — instead the
 * row → file-line map below feeds Monaco's `lineNumbers` function, so the
 * gutter shows real new-file numbers with real gaps where lines were removed.
 */
export function renderFileDiff(file: FileDiff): RenderedDiff {
  const rows: RenderedRow[] = [];

  for (const hunk of file.hunks) {
    const range = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
    rows.push({
      kind: "hunk",
      text: hunk.section ? `${range} ${hunk.section}` : range,
      oldLineNo: null,
      newLineNo: null,
    });

    for (const line of hunk.lines) {
      rows.push({
        kind: line.kind,
        text: line.content,
        oldLineNo: line.oldLineNo,
        newLineNo: line.newLineNo,
      });
    }
  }

  return { text: rows.map((row) => row.text).join("\n"), rows };
}

/** 1-based editor line for a new-file line number, or null if not in the diff. */
export function rowForNewLine(
  rendered: RenderedDiff,
  newLineNo: number,
): number | null {
  const index = rendered.rows.findIndex((row) => row.newLineNo === newLineNo);
  return index === -1 ? null : index + 1;
}

export interface RowRange {
  startRow: number;
  endRow: number;
  /**
   * False when the comment's lines are not in the diff at all and the range
   * fell back to a hunk header.
   *
   * This happens for real: the LLM is given retrieved context as well as the
   * diff, so it can comment on a line nobody touched. Pinning that to the
   * nearest hunk header keeps the comment visible and honest, where dropping
   * it would hide a real finding and guessing a line would be a lie.
   */
  exact: boolean;
}

export function rowRangeForComment(
  rendered: RenderedDiff,
  lineStart: number,
  lineEnd: number,
): RowRange | null {
  if (rendered.rows.length === 0) return null;

  const rowsInRange: number[] = [];
  rendered.rows.forEach((row, index) => {
    if (
      row.newLineNo !== null &&
      row.newLineNo >= lineStart &&
      row.newLineNo <= lineEnd
    ) {
      rowsInRange.push(index + 1);
    }
  });

  if (rowsInRange.length > 0) {
    return {
      startRow: rowsInRange[0],
      endRow: rowsInRange[rowsInRange.length - 1],
      exact: true,
    };
  }

  // Nearest hunk header, measured against the hunk's first new-file line.
  let bestRow = 1;
  let bestDistance = Infinity;
  let pendingHeader = 1;

  rendered.rows.forEach((row, index) => {
    if (row.kind === "hunk") {
      pendingHeader = index + 1;
      return;
    }
    if (row.newLineNo === null) return;

    const distance = Math.abs(row.newLineNo - lineStart);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRow = pendingHeader;
    }
  });

  return { startRow: bestRow, endRow: bestRow, exact: false };
}

/** Monaco language id from a file extension. Unknown extensions get none. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  css: "css",
  scss: "scss",
  html: "html",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  dockerfile: "dockerfile",
};

export function languageForPath(path: string): string {
  const name = path.split("/").pop() ?? "";
  if (name.toLowerCase() === "dockerfile") return "dockerfile";

  const extension = name.includes(".")
    ? name.split(".").pop()!.toLowerCase()
    : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}
