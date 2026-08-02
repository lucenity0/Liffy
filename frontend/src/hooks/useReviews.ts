import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { listReviews, type ListReviewsParams } from "@/api/reviews";
import { keys } from "./keys";

export const REVIEWS_PAGE_SIZE = 20;

/**
 * Drops keys whose value is `undefined`.
 *
 * The query key is built from this object, so `{repoId: undefined}` and `{}`
 * would otherwise be two cache entries holding identical data — one filled by
 * the page that passes filters explicitly, one by the caller that does not.
 * It is also what keeps unset filters out of the query string, since the
 * same object is handed to `listReviews`.
 */
function defined(params: ListReviewsParams): ListReviewsParams {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
}

/**
 * `placeholderData: keepPreviousData` is v5's replacement for v4's
 * `keepPreviousData: true`. It keeps the current page rendered while the
 * next one loads, so paging does not flash an empty table.
 */
export function useReviews(
  params: ListReviewsParams = {},
  options?: { enabled?: boolean },
) {
  const limit = params.limit ?? REVIEWS_PAGE_SIZE;
  const offset = params.offset ?? 0;

  // The *whole* params object, not just `{limit, offset}`. Two different
  // filters that shared a key would serve each other's rows — the repo filter
  // would show whatever the status filter fetched last.
  const query = defined({ ...params, limit, offset });

  const result = useQuery({
    queryKey: keys.reviews.list(query),
    queryFn: () => listReviews(query),
    enabled: options?.enabled ?? true,
    placeholderData: keepPreviousData,
  });

  const total = result.data?.total ?? 0;
  const items = result.data?.items ?? [];

  return {
    ...result,
    items,
    total,
    /**
     * A real answer, from the count the endpoint now returns. This used to be
     * inferred from a full page, which offered a Next that led nowhere on any
     * total that landed on a page boundary — and filters make a set land on a
     * boundary far more often than the unfiltered table does.
     */
    hasNextPage: offset + items.length < total,
    hasPreviousPage: offset > 0,
  };
}
