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
 * No count chip in the header: GET /reviews has no total, so the only honest
 * number here would be "5 of ?".
 */
export function RecentReviews() {
  const reviews = useReviews({ limit: RECENT_REVIEWS_LIMIT });

  return (
    <Sheet>
      <Sheet.Header
        title="Recent reviews"
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

      {reviews.data?.length === 0 && (
        <EmptyState
          title="Nothing reviewed yet."
          description="Open a pull request on a connected repository, or trigger a review by hand, and it will show up here."
        />
      )}

      {reviews.data && reviews.data.length > 0 && (
        <Sheet.List as="ul" aria-label="Recent reviews">
          {reviews.data.map((review) => (
            <ReviewRow key={review.id} review={review} />
          ))}
        </Sheet.List>
      )}
    </Sheet>
  );
}
