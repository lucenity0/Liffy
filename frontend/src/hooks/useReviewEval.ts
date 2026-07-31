import { useQuery } from "@tanstack/react-query";
import { getReviewEval } from "@/api/analytics";
import { keys } from "./keys";

/**
 * Report §8.1's approval rate for one review, computed live.
 *
 * No `refetchInterval`. The number only moves when somebody rates a comment,
 * and that already invalidates `keys.reviews.detail(reviewId)` — which this
 * key nests under, so the refetch arrives without a poll.
 *
 * `enabled` is the caller's call because a pending or processing review has
 * no comments to rate yet: the request would be a guaranteed empty answer,
 * fired alongside the 3s poll ReviewDetail is already running in that state.
 */
export function useReviewEval(
  reviewId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: keys.reviews.eval(reviewId ?? ""),
    queryFn: () => getReviewEval(reviewId!),
    enabled: Boolean(reviewId) && (options?.enabled ?? true),
  });
}
