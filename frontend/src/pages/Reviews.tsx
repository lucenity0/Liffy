import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { Pagination } from "@/components/review/Pagination";
import { ReviewRow } from "@/components/review/ReviewRow";
import { TriggerReviewForm } from "@/components/review/TriggerReviewForm";
import { REVIEWS_PAGE_SIZE, useReviews } from "@/hooks/useReviews";
import { parseOffset } from "@/lib/pagination";

export function Reviews() {
  const [searchParams, setSearchParams] = useSearchParams();
  const offset = parseOffset(searchParams.get("offset"));

  const reviews = useReviews({ limit: REVIEWS_PAGE_SIZE, offset });
  const rows = reviews.data ?? [];

  const [triggering, setTriggering] = useState(false);
  const [queued, setQueued] = useState<{
    repo: string;
    pr_number: number;
  } | null>(null);

  function goTo(next: number) {
    // `replace: false` keeps paging in history, which is the point of putting
    // it in the URL at all. Offset 0 drops the param instead of writing ?offset=0.
    setSearchParams(next === 0 ? {} : { offset: String(next) });
  }

  /**
   * The 202 carries repo and pr_number but no review id, so there is nothing
   * to deep-link to. Close the modal, drop back to page one — the new row is
   * the newest, and it is not on page three — and say what happened. The
   * mutation already invalidated the list; the row appears once the worker
   * has created it, which is a moment later, not instantly.
   */
  function onQueued(accepted: { repo: string; pr_number: number }) {
    setTriggering(false);
    setQueued(accepted);
    goTo(0);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-hand text-2xl leading-tight text-ink">Reviews</h1>
          <p className="text-base text-ink-dim">
            Everything Liffy has read, newest first.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => setTriggering(true)}
          className="ml-auto"
        >
          New review
        </Button>
      </header>

      {queued && (
        <p
          role="status"
          className="rounded-sheet border border-sage/30 bg-sage-tint px-4 py-3 text-base text-ink"
        >
          Queued — Liffy is reading{" "}
          <span className="font-code">
            {queued.repo}
            <span className="text-ink-sub"> #</span>
            <span data-numeric>{queued.pr_number}</span>
          </span>
          . It appears below once the worker picks it up.
        </p>
      )}

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
                ? "Open a pull request on a connected repository, or point Liffy at one yourself."
                : "You have paged past the end. Go back a page."
            }
            action={
              offset === 0 ? (
                <Button variant="primary" onClick={() => setTriggering(true)}>
                  Review a pull request
                </Button>
              ) : undefined
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

      {triggering && (
        <TriggerReviewForm
          onClose={() => setTriggering(false)}
          onQueued={onQueued}
        />
      )}
    </div>
  );
}
