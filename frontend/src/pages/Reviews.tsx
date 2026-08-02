import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { Pagination } from "@/components/review/Pagination";
import { ReviewFilterBar } from "@/components/review/ReviewFilterBar";
import { ReviewRow } from "@/components/review/ReviewRow";
import { TriggerReviewForm } from "@/components/review/TriggerReviewForm";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { REVIEWS_PAGE_SIZE, useReviews } from "@/hooks/useReviews";
import { isValidPrNumber } from "@/lib/validators";
import {
  hasActiveFilters,
  parseOffset,
  parseReviewFilters,
  type ReviewFilters,
} from "@/lib/pagination";

/** The PR number box's value, as text, for a filter that may be unset. */
const asPrText = (value: number | undefined) =>
  value === undefined ? "" : String(value);

export function Reviews() {
  const [searchParams, setSearchParams] = useSearchParams();
  const offset = parseOffset(searchParams.get("offset"));
  const filters = parseReviewFilters(searchParams);
  const filtered = hasActiveFilters(filters);

  const reviews = useReviews({
    limit: REVIEWS_PAGE_SIZE,
    offset,
    repoId: filters.repoId,
    prNumber: filters.prNumber,
    status: filters.status,
    sort: filters.sort,
  });
  const rows = reviews.items;

  const [triggering, setTriggering] = useState(false);
  const [queued, setQueued] = useState<{
    repo: string;
    pr_number: number;
  } | null>(null);

  /** The URL, rebuilt from a filter set and an offset. Offset 0 and every
   *  unset filter drop out entirely rather than being written empty. */
  function write(next: ReviewFilters, nextOffset: number) {
    const params: Record<string, string> = {};
    if (next.repoId) params.repo = next.repoId;
    if (next.prNumber !== undefined) params.pr = String(next.prNumber);
    if (next.status) params.status = next.status;
    if (next.sort !== "newest") params.sort = next.sort;
    if (nextOffset !== 0) params.offset = String(nextOffset);
    setSearchParams(params);
  }

  function goTo(next: number) {
    // `replace: false` keeps paging in history, which is the point of putting
    // it in the URL at all. Offset 0 drops the param instead of writing ?offset=0.
    write(filters, next);
  }

  /**
   * Any filter change returns to page one.
   *
   * Without this, switching to a repo with three reviews while sitting on
   * `?offset=40` renders "You have paged past the end" — which is
   * indistinguishable from a bug, and is reached by an ordinary click.
   */
  function changeFilters(next: Partial<ReviewFilters>) {
    write({ ...filters, ...next }, 0);
  }

  /**
   * The PR number box types faster than it filters, so its displayed value
   * lives here as a draft and only reaches the URL once typing settles —
   * otherwise "203" asks the API about PR 2 and PR 20 on the way.
   *
   * It lives *here*, next to the writes, rather than inside the filter bar:
   * a clear has to reset the box and the URL together, and a bar holding its
   * own draft cannot tell that a clear happened when `pr` was absent both
   * before and after — so a pending keystroke would publish itself back on
   * top of the clear a beat later.
   */
  const [prDraft, setPrDraft] = useState(() => asPrText(filters.prNumber));
  const settledPr = useDebouncedValue(prDraft.trim());

  /**
   * Re-seed the box when the URL moves under it — the back button, or a
   * pasted link. Adjusting state during render rather than in an effect:
   * React re-runs this component before touching the DOM, so there is no
   * flash of the stale value and no cascading render.
   *
   * Safe against clobbering a half-typed number because a draft only reaches
   * the URL once it has been still for the debounce, so by the time the value
   * comes back around the two already agree.
   */
  const [publishedPr, setPublishedPr] = useState(filters.prNumber);
  if (filters.prNumber !== publishedPr) {
    setPublishedPr(filters.prNumber);
    setPrDraft(asPrText(filters.prNumber));
  }

  useEffect(() => {
    if (settledPr === "") {
      if (filters.prNumber !== undefined) changeFilters({ prNumber: undefined });
      return;
    }
    // Invalid input is left alone rather than pushed to the URL: it would
    // degrade to "no filter" on the way back in, which reads as the box
    // silently clearing itself while you are still typing.
    if (!isValidPrNumber(settledPr)) return;
    const parsed = Number(settledPr);
    if (parsed !== filters.prNumber) changeFilters({ prNumber: parsed });
    // Publishes the settled draft outward. `filters.prNumber` stays out of the
    // dependencies: reacting to the value coming back in is what the render
    // adjustment above is for, and doing both here would have them fight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledPr]);

  /**
   * The one way back to the unfiltered list, used by all three things that
   * offer it. The draft is reset in the same breath as the URL — that is the
   * whole reason this is one function rather than three `setSearchParams({})`
   * calls, since forgetting it at any one of them resurrects the filter.
   */
  function clearFilters() {
    setSearchParams({});
    setPrDraft("");
    setPublishedPr(undefined);
  }

  /**
   * The 202 carries repo and pr_number but no review id, so there is nothing
   * to deep-link to. Close the modal, drop back to page one — the new row is
   * the newest, and it is not on page three — and say what happened. The
   * mutation already invalidated the list; the row appears once the worker
   * has created it, which is a moment later, not instantly.
   *
   * Filters are cleared alongside: a review queued while filtered to "failed"
   * would otherwise be announced as queued and then not appear, because it is
   * not failed.
   */
  function onQueued(accepted: { repo: string; pr_number: number }) {
    setTriggering(false);
    setQueued(accepted);
    clearFilters();
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-hand text-2xl leading-tight text-ink">Reviews</h1>
          {/* The standing description claims two separate things, and they
              break separately: only a filter stops this being "everything",
              and only the order control changes the order. Both are visible
              on screen, so saying either wrongly is worse than not saying
              it — hence the order is named rather than assumed. */}
          <p className="text-base text-ink-dim">
            {filtered
              ? "A filtered view. Clear the filters to see everything."
              : filters.sort === "oldest"
                ? "Everything Liffy has read, oldest first."
                : "Everything Liffy has read, newest first."}
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

      <ReviewFilterBar
        filters={filters}
        prDraft={prDraft}
        onPrDraftChange={setPrDraft}
        onChange={changeFilters}
        onClear={clearFilters}
      />

      <Sheet>
        <Sheet.Header
          title={filtered ? "Filtered reviews" : "All reviews"}
          count={reviews.data ? reviews.total : undefined}
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

        {/* Three different nothings, which are three different situations:
            nothing exists yet, nothing matches, or you have walked off the
            end. "Nothing reviewed yet." in front of a filtered list is both
            wrong and alarming — the reviews are there, they just do not
            match. */}
        {reviews.data && rows.length === 0 && (
          <EmptyState
            title={
              filtered
                ? "No reviews match these filters."
                : offset === 0
                  ? "Nothing reviewed yet."
                  : "Nothing on this page."
            }
            description={
              filtered
                ? "Nothing has been reviewed that fits. Widen the filters, or clear them to see everything."
                : offset === 0
                  ? "Open a pull request on a connected repository, or point Liffy at one yourself."
                  : "You have paged past the end. Go back a page."
            }
            action={
              filtered ? (
                <Button onClick={clearFilters}>Clear filters</Button>
              ) : offset === 0 ? (
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
