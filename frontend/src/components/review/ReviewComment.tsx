import { CategoryBadge, SeverityBadge } from "@/components/ui/badgeMaps";
import { cn } from "@/lib/utils";
import type { ReviewCommentOut } from "@/types/api";

/**
 * One line-anchored comment. Not a Sheet — these already sit inside one, and
 * nesting would draw a second hairline around every card. A row with a
 * severity-tinted left edge instead, which also makes a file's worst comment
 * findable while scrolling.
 */
const EDGE: Record<string, string> = {
  critical: "border-l-oxide",
  warning: "border-l-ochre",
  info: "border-l-payne",
};

export function ReviewComment({ comment }: { comment: ReviewCommentOut }) {
  const lines =
    comment.line_start === comment.line_end
      ? `${comment.line_start}`
      : `${comment.line_start}–${comment.line_end}`;

  return (
    <article
      className={cn(
        "flex flex-col gap-2 border-l-2 px-4 py-3",
        EDGE[comment.severity] ?? "border-l-rule-strong",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge value={comment.severity} />
        <CategoryBadge value={comment.category} />
        <span className="ml-auto font-code text-sm text-ink-sub" data-numeric>
          {/* The anchor Liffy posted the comment against, spelled the way a
              diff spells it. */}
          {comment.file_path}:{lines}
        </span>
      </div>

      <p className="prose-hand">{comment.comment_text}</p>

      {comment.suggestion && (
        <div className="flex flex-col gap-1">
          <p className="label">Suggestion</p>
          <pre className="rounded-chip overflow-x-auto border border-rule bg-recessed px-3 py-2">
            <code className="font-code text-sm text-ink">
              {comment.suggestion}
            </code>
          </pre>
        </div>
      )}
    </article>
  );
}
