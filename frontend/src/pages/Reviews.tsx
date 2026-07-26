import { useSearchParams } from "react-router-dom";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { Pagination } from "@/components/review/Pagination";
import { ReviewRow } from "@/components/review/ReviewRow";
import { REVIEWS_PAGE_SIZE, useReviews } from "@/hooks/useReviews";
import { parseOffset } from "@/lib/pagination";

export function Reviews() {
  const [searchParams, setSearchParams] = useSearchParams();
  const offset = parseOffset(searchParams.get("offset"));

  const reviews = useReviews({ limit: REVIEWS_PAGE_SIZE, offset });
  const rows = reviews.data ?? [];

  function goTo(next: number) {
    // `replace: false` keeps paging in history, which is the point of putting
    // it in the URL at all. Offset 0 drops the param instead of writing ?offset=0.
    setSearchParams(next === 0 ? {} : { offset: String(next) });
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-hand text-2xl leading-tight text-ink">Reviews</h1>
        <p className="text-base text-ink-dim">
          Everything Liffy has read, newest first.
        </p>
      </header>

      <Sheet>
        <Sheet.Header
          title="All reviews"
          actions={
            // Paging keeps the previous page on screen (keepPreviousData), so
            // without this the only sign anything is happening is the URL.
            reviews.isFetching && !reviews.isPending ? (
              <span className="label">Loading…</span>
            ) : undefined
          }
        />

        {reviews.isPending && <SkeletonRows rows={6} />}

        {reviews.isError && (
          <Sheet.Body>
            <ErrorNote error={reviews.error} onRetry={() => reviews.refetch()} />
          </Sheet.Body>
        )}

        {reviews.data?.length === 0 && (
          <EmptyState
            title={
              offset === 0 ? "Nothing reviewed yet." : "Nothing on this page."
            }
            description={
              offset === 0
                ? "Open a pull request on a connected repository, or trigger a review by hand."
                : "You have paged past the end. Go back a page."
            }
          />
        )}

        {rows.length > 0 && (
          <Sheet.List as="ul" aria-label="Reviews">
            {rows.map((review) => (
              <ReviewRow key={review.id} review={review} detailed />
            ))}
          </Sheet.List>
        )}

        <Sheet.Footer>
          <Pagination
            offset={offset}
            count={rows.length}
            hasPrevious={reviews.hasPreviousPage}
            hasNext={reviews.hasNextPage}
            onPrevious={() => goTo(Math.max(0, offset - REVIEWS_PAGE_SIZE))}
            onNext={() => goTo(offset + REVIEWS_PAGE_SIZE)}
          />
        </Sheet.Footer>
      </Sheet>
    </div>
  );
}
