import { useMutation, useQueryClient } from "@tanstack/react-query";
import { submitCommentFeedback } from "@/api/feedback";
import type { ReviewDetailOut } from "@/types/api";
import { keys } from "./keys";

/**
 * Rate one comment, optimistically.
 *
 * The round trip is not slow, but a thumb that waits for it reads as broken —
 * so the cache is written first and rolled back if the POST fails. This is the
 * only optimistic mutation in the app; `useRereview` and `useTriggerReview`
 * both invalidate-and-wait, which is right for them because neither has a
 * control whose pressed state *is* the thing being written.
 *
 * `reviewId` is a hook argument rather than something dug out of the router,
 * because the cache key is per review and the hook should not have to know it
 * is being rendered under `/reviews/:reviewId`.
 *
 * One instance per comment, deliberately. A single mutation shared across the
 * list would make `isPending` true for all eight comments the moment one is
 * rated, disabling every other thumb on the page.
 */
export function useCommentFeedback(reviewId: string) {
  const queryClient = useQueryClient();
  const queryKey = keys.reviews.detail(reviewId);

  return useMutation({
    mutationFn: ({ commentId, rating }: { commentId: string; rating: 1 | -1 }) =>
      submitCommentFeedback(commentId, rating),

    onMutate: async ({ commentId, rating }) => {
      // Not optional. ReviewDetail polls every 3s while a review is still
      // processing, and an in-flight refetch that resolves *after* this write
      // lands would overwrite it — the button would revert under the user's
      // finger with no error to explain it.
      await queryClient.cancelQueries({ queryKey });

      const previous = queryClient.getQueryData<ReviewDetailOut>(queryKey);

      queryClient.setQueryData<ReviewDetailOut>(queryKey, (current) =>
        current
          ? {
              // New objects the whole way down to the one comment that
              // changed. Mutating `current.comments[i].my_rating` in place
              // would leave every reference identical and React would not
              // re-render the thumb that was just clicked.
              ...current,
              comments: current.comments.map((comment) =>
                comment.id === commentId
                  ? { ...comment, my_rating: rating }
                  : comment,
              ),
            }
          : current,
      );

      return { previous };
    },

    onError: (_error, _variables, context) => {
      // `previous` is undefined when nothing was cached, which is also the
      // case where the optimistic write above was a no-op — so there is
      // genuinely nothing to restore, and writing `undefined` back would
      // evict a query that the failure had no business evicting.
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },

    // Both paths: the server is the authority on what was stored, and after a
    // failure the rollback above is a guess about what it still holds.
    //
    // The promise is deliberately *not* returned. TanStack keeps a mutation
    // `isPending` until whatever `onSettled` returns resolves, so returning it
    // would hold both thumbs disabled for the refetch as well as the POST —
    // reintroducing the exact wait the optimistic write exists to remove, and
    // delaying the failure message behind a request that has nothing to say
    // about it. The refetch still happens; the control just stops waiting on
    // it, which it can afford to because the cache is already correct.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}
