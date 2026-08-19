import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listPrCommits, reviewCommits } from "@/api/reviews";
import { keys } from "./keys";

/**
 * Commits on a pull request, fetched only when asked for.
 *
 * `enabled` rather than fetching on mount: this costs a GitHub API call per
 * open review page, and most visits to a review are to read it rather than to
 * queue another one. The button is the request.
 */
export function usePrCommits(prId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.reviews.commits(prId ?? ""),
    queryFn: () => listPrCommits(prId!),
    enabled: Boolean(prId) && enabled,
    // A pull request's commit list does not change while you look at it, and
    // a refetch is a GitHub call. Refetching is what the button is for.
    staleTime: Infinity,
  });
}

export function useReviewCommits() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ prId, shas }: { prId: string; shas: string[] }) =>
      reviewCommits(prId, shas),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.reviews.all }),
  });
}
