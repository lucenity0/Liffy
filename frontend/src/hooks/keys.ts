import type { ListReviewsParams } from "@/api/reviews";

/**
 * The only place query key strings are written. Invalidation bugs come from
 * stringly-typed keys built at the call site, so nothing outside this file
 * should ever type the literal "repos" or "reviews".
 *
 * Keys nest by prefix, so `invalidateQueries({queryKey: keys.repos.all})`
 * catches the list *and* every per-repo status query underneath it.
 */
export const keys = {
  repos: {
    all: ["repos"] as const,
    list: () => [...keys.repos.all, "list"] as const,
    status: (repoId: string) => [...keys.repos.all, repoId, "status"] as const,
  },
  reviews: {
    all: ["reviews"] as const,
    list: (params: ListReviewsParams) =>
      [...keys.reviews.all, "list", params] as const,
    detail: (reviewId: string) =>
      [...keys.reviews.all, "detail", reviewId] as const,
    /**
     * Nested *under* the detail key, not beside it, and spelled by spreading
     * `detail(...)` so it cannot drift out from under it.
     *
     * That nesting is the whole mechanism: rating a comment invalidates
     * `detail(reviewId)`, and prefix matching carries the invalidation down to
     * the score. Neither the rating mutation nor this query has to know the
     * other exists. Flattened to `[...all, "eval", reviewId]` the number would
     * sit there stale until a reload.
     */
    eval: (reviewId: string) =>
      [...keys.reviews.detail(reviewId), "eval"] as const,
  },
  /**
   * A new top-level group rather than a branch of `reviews`: this is neither
   * a repo nor a review, it spans both, and nesting it under either would
   * make an unrelated invalidation refetch the whole dashboard.
   */
  analytics: {
    all: ["analytics"] as const,
    summary: () => [...keys.analytics.all, "summary"] as const,
  },
} as const;
