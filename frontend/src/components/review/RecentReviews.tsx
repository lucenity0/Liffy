import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { useReviews } from "@/hooks/useReviews";
import { ReviewRow } from "./ReviewRow";

export const RECENT_REVIEWS_LIMIT = 5;

/**
 * The five most recent reviews. One Sheet, unlike the repo grid — these are
 * rows of one list rather than separate leaves, so they belong inside a single
 * bordered box with hairlines between them.
 *
 * The header now carries a real count, because the endpoint returns one. It
 * is the total across every repository, not the five on screen — which is the
 * number that says whether "All reviews" is worth a click.
 */
export function RecentReviews() {
  // Failures are excluded here and nowhere else. This is the page you land
  // on, and a run that died on a rate limit or a missing CLI is a fact about
  // your setup rather than about your code — it belongs on /reviews, where it
  // can be read next to the others and filtered for deliberately.
  //
  // Not `status: "completed"`: a queued or processing review is the most
  // interesting row this list can show, and narrowing to completed would hide
  // exactly the async behaviour the dashboard is meant to display.
  const reviews = useReviews({
    limit: RECENT_REVIEWS_LIMIT,
    includeFailed: false,
  });

  return (
    <Sheet>
      <Sheet.Header
        title="Recent reviews"
        // Omitted until the first page lands, so the chip does not flash a 0
        // on the way to a real number.
        count={reviews.data ? reviews.total : undefined}
        actions={
          <ButtonLink to="/reviews" variant="ghost">
            All reviews
          </ButtonLink>
        }
      />

      {reviews.isPending && <SkeletonRows rows={3} />}

      {reviews.isError && (
        <Sheet.Body>
          <ErrorNote error={reviews.error} onRetry={() => reviews.refetch()} />
        </Sheet.Body>
      )}

      {reviews.data && reviews.items.length === 0 && (
        <EmptyState
          title="Nothing reviewed yet."
          description="Open a pull request on a connected repository, or trigger a review by hand, and it will show up here."
        />
      )}

      {reviews.items.length > 0 && (
        <Sheet.List as="ul" aria-label="Recent reviews">
          {reviews.items.map((review) => (
            <ReviewRow key={review.id} review={review} />
          ))}
        </Sheet.List>
      )}
    </Sheet>
  );
}
