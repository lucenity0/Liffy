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
    pulls: (repoId: string, state: string) =>
      [...keys.repos.all, repoId, "pulls", state] as const,
  },
  reviews: {
    all: ["reviews"] as const,
    list: (params: ListReviewsParams) =>
      [...keys.reviews.all, "list", params] as const,
    detail: (reviewId: string) =>
      [...keys.reviews.all, "detail", reviewId] as const,
    /**
     * Beside `list` rather than under it: this is one row the server picks,
     * not a page the client asked for, so no list invalidation should reach
     * it and no filter belongs in its key.
     */
    latestFinding: () => [...keys.reviews.all, "latest-finding"] as const,
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
    // Keyed by the window: a 7-day and a 30-day answer are different data,
    // and sharing one entry would serve whichever loaded last.
    activity: (days: number) => [...keys.analytics.all, "activity", days] as const,
  },
  /**
   * One document, not a list — there is no per-key query, because the page
   * renders every setting at once and a PATCH can change the provenance of a
   * key it did not name.
   */
  analyticsModels: {
    all: ["analytics", "models"] as const,
  },
  settings: {
    all: ["settings"] as const,
  },
  /**
   * Static content that ships with the image, so nothing here is ever
   * invalidated — a document changes only when the app is redeployed, which
   * takes the whole cache with it.
   */
  help: {
    all: ["help"] as const,
    topics: () => [...keys.help.all, "topics"] as const,
    search: (q: string) => [...keys.help.all, "search", q] as const,
    page: (slug: string) => [...keys.help.all, "page", slug] as const,
  },
} as const;
