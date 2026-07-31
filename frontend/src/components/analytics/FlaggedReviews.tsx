import { EmptyState } from "@/components/ui/EmptyState";
import { Sheet } from "@/components/ui/Sheet";
import { formatPercent } from "@/lib/utils";
import type { FlaggedReview } from "@/types/api";

/**
 * Report §8.2: reviews scoring under 50% approval are flagged for manual
 * inspection. #192 flags them and #194 returns them; without this list,
 * "flagged for manual inspection" means "written to a column nobody reads".
 *
 * Read from `eval_scores` — the weekly snapshot — unlike everything else on
 * this page, which is computed live. So the list is empty until that job has
 * run once, and can lag a rating by up to a week. The footer says so, because
 * an empty list that means "not computed yet" and an empty list that means
 * "nothing is wrong" look identical.
 */
export function FlaggedReviews({
  reviews,
  total,
}: {
  reviews: FlaggedReview[];
  /** The true count. #194 caps the list at 20. */
  total: number;
}) {
  const truncated = total > reviews.length;

  return (
    <Sheet aria-label="Flagged reviews">
      <Sheet.Header title="Flagged for inspection" count={total} />

      {reviews.length === 0 ? (
        // Empty is the good outcome here, so it reads as reassurance rather
        // than as an absence of data.
        <EmptyState
          title="Nothing flagged."
          description="No review has scored below 50% approval."
        />
      ) : (
        <Sheet.List>
          {reviews.map((review) => (
            <Sheet.Row key={review.review_id} to={`/reviews/${review.review_id}`}>
              <span className="font-code text-base text-ink">
                {review.repo_full_name}
              </span>
              <span className="font-code text-sm text-ink-dim" data-numeric>
                #{review.pr_number}
              </span>
              <span className="ml-auto text-base text-oxide" data-numeric>
                {formatPercent(review.approval_rate)} approval
              </span>
            </Sheet.Row>
          ))}
        </Sheet.List>
      )}

      <Sheet.Footer>
        <p className="text-sm text-ink-dim">
          {/* A silently truncated list reads as a complete one. */}
          {truncated
            ? `Showing ${reviews.length} of ${total}. `
            : ""}
          Flags come from the weekly evaluation job, so this can lag a rating
          by up to a week.
        </p>
      </Sheet.Footer>
    </Sheet>
  );
}
