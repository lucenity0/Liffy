import type { ReviewCommentOut, Severity } from "@/types/api";

/**
 * Worst-first ordering. `satisfies` keeps it exhaustive: a new severity fails
 * typecheck here rather than silently sorting to the end.
 */
export const SEVERITY_RANK = {
  critical: 0,
  warning: 1,
  info: 2,
} satisfies Record<Severity, number>;

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity] ?? 99;
}

export interface CommentGroup {
  filePath: string;
  comments: ReviewCommentOut[];
  /** Worst severity in the file, so a group header can say what is inside. */
  worst: Severity;
}

/**
 * Groups a review's comments by file, alphabetically, with each file's
 * comments in line order — the order you would read the diff in.
 *
 * The backend returns comments in insertion order, which is whatever order
 * the LLM emitted them. Reading a review file-by-file is the whole point of
 * the page, so the sort is not cosmetic.
 *
 * Ties on `line_start` break on `line_end`, so a comment on lines 10-12 and
 * another on 10-40 always land the same way round rather than depending on
 * the sort being stable.
 */
export function groupCommentsByFile(
  comments: ReviewCommentOut[],
): CommentGroup[] {
  const byFile = new Map<string, ReviewCommentOut[]>();

  for (const comment of comments) {
    const existing = byFile.get(comment.file_path);
    if (existing) existing.push(comment);
    else byFile.set(comment.file_path, [comment]);
  }

  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, fileComments]) => {
      const sorted = [...fileComments].sort(
        (a, b) => a.line_start - b.line_start || a.line_end - b.line_end,
      );
      return {
        filePath,
        comments: sorted,
        worst: sorted.reduce(
          (worst, comment) =>
            severityRank(comment.severity) < severityRank(worst)
              ? comment.severity
              : worst,
          sorted[0].severity,
        ),
      };
    });
}
