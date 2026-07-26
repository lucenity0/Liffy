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
  },
} as const;
