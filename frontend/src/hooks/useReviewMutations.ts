import { useMutation, useQueryClient } from "@tanstack/react-query";
import { rereview, triggerReview } from "@/api/reviews";
import { keys } from "./keys";

/**
 * Both mutations return a 202 whose body is `{status, repo, pr_number}` —
 * deliberately no review id. Neither caller can deep-link to what it just
 * created; they invalidate the list and let its own polling surface the new
 * row.
 */

export function useTriggerReview() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: triggerReview,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.reviews.all }),
  });
}

/**
 * Re-review creates a NEW review row rather than resetting the one on
 * screen, so the current detail query will never change state on its own.
 * The caller has to navigate away — see ReviewDetail, which routes to the
 * list. Invalidating only the list reflects that.
 */
export function useRereview() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (reviewId: string) => rereview(reviewId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.reviews.all }),
  });
}
