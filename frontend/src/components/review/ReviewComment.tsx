import { Button } from "@/components/ui/Button";
import { CategoryBadge, SeverityBadge } from "@/components/ui/badgeMaps";
import { ModelProse } from "@/components/ui/ModelProse";
import {
  commentAnchorId,
  formatLineRange,
  severityEdge,
} from "@/lib/reviewUtils";
import { cn } from "@/lib/utils";
import type { ReviewCommentOut } from "@/types/api";
import { CommentRating } from "./CommentRating";

/**
 * One line-anchored comment. Not a Sheet — these already sit inside one, and
 * nesting would draw a second hairline around every card. A row with a
 * severity-tinted left edge instead, which also makes a file's worst comment
 * findable while scrolling.
 */
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
  const lines = formatLineRange(comment.line_start, comment.line_end);

  return (
    <article
      id={commentAnchorId(comment.id)}
      className={cn(
        "flex flex-col gap-2 border-l-2 px-4 py-3",
        severityEdge(comment.severity),
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge value={comment.severity} />
        <CategoryBadge value={comment.category} />
        {/* Quieter than the category badge, which is already quieter than
            severity — a de-emphasis signal should not compete with the thing
            it de-emphasises. Plain dim text rather than a third badge, for the
            same reason categories are monochrome: severity is what you triage
            by and it has to stay the loudest thing in this row.

            Rendered only for "plausible". Nothing for "confirmed" — the common
            case — and nothing for null, which is every comment written before
            the field existed. A marker on every comment is not a marker. */}
        {comment.confidence === "plausible" && (
          <span className="label text-ink-dim">plausible</span>
        )}
        <span className="ml-auto font-code text-sm text-ink-sub" data-numeric>
          {/* The anchor Liffy posted the comment against, spelled the way a
              diff spells it. */}
          {comment.file_path}:{lines}
        </span>
      </div>

      <ModelProse text={comment.comment_text} />

      {/* Secondary to the comment, and after it: the comment says what is
          wrong, this says how to make it happen, and a reader deciding whether
          to act wants them in that order.

          Through `ModelProse` like the comment above it — this is the same
          untrusted model prose, derived from the same attacker-authored diff,
          and it gets the same structural guarantee rather than a second
          treatment that might not have one.

          Absent, not empty, when null. Most rows in the table are null. */}
      {comment.failure_scenario && (
        <div className="flex flex-col gap-1">
          <p className="label text-ink-dim">Fails when</p>
          <ModelProse
            text={comment.failure_scenario}
            className="text-ink-sub"
          />
        </div>
      )}

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
