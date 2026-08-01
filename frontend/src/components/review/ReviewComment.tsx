import { Button } from "@/components/ui/Button";
import { CategoryBadge, SeverityBadge } from "@/components/ui/badgeMaps";
import { commentAnchorId } from "@/lib/reviewUtils";
import { cn } from "@/lib/utils";
import type { ReviewCommentOut } from "@/types/api";
import { CommentRating } from "./CommentRating";

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

export function ReviewComment({
  comment,
  reviewId,
  onReveal,
}: {
  comment: ReviewCommentOut;
  /** Which review's cache a rating writes into — the key is per review. */
  reviewId: string;
  /** Present only when there is a diff to reveal it in. */
  onReveal?: (comment: ReviewCommentOut) => void;
}) {
  const lines =
    comment.line_start === comment.line_end
      ? `${comment.line_start}`
      : `${comment.line_start}–${comment.line_end}`;

  return (
    <article
      id={commentAnchorId(comment.id)}
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

      {/* Actions last, below the suggestion rather than above it: the thing
          being rated is the comment *and* whatever it proposes, so asking
          before the proposal is on screen asks about half of it.

          The rating does not go in the badge row — that row is what Liffy
          said about the code, and a control that records what you think of it
          is not more of the same metadata. */}
      <div className="flex items-start gap-2 pt-1">
        {onReveal && (
          <Button variant="ghost" onClick={() => onReveal(comment)}>
            Show in diff
          </Button>
        )}
        <div className="ml-auto">
          <CommentRating comment={comment} reviewId={reviewId} />
        </div>
      </div>
    </article>
  );
}
