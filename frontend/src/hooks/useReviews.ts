import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { listReviews, type ListReviewsParams } from "@/api/reviews";
import { keys } from "./keys";

export const REVIEWS_PAGE_SIZE = 20;

/**
 * `placeholderData: keepPreviousData` is v5's replacement for v4's
 * `keepPreviousData: true`. It keeps the current page rendered while the
 * next one loads, so paging does not flash an empty table.
 *
 * GET /reviews returns no total count, so callers cannot compute a last
 * page — see `hasNextPage` below, which infers it from a short page.
 */
export function useReviews(params: ListReviewsParams = {}) {
  const limit = params.limit ?? REVIEWS_PAGE_SIZE;
  const offset = params.offset ?? 0;

  const query = useQuery({
    queryKey: keys.reviews.list({ limit, offset }),
    queryFn: () => listReviews({ limit, offset }),
    placeholderData: keepPreviousData,
  });

  return {
    ...query,
    /** A full page implies there may be more; a short one is definitely last. */
    hasNextPage: (query.data?.length ?? 0) === limit,
    hasPreviousPage: offset > 0,
  };
}
