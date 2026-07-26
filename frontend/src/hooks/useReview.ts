import { useQuery } from "@tanstack/react-query";
import { getReview } from "@/api/reviews";
import { keys } from "./keys";

/** The two states where the worker is still going to change this row. */
const IN_FLIGHT = new Set(["pending", "processing"]);

/**
 * Polls a review every 3s while the worker still has it, and stops the
 * moment it reaches `completed` or `failed`. That poll is what makes the
 * detail page flip live from "Liffy is reading…" to the finished review
 * without the user refreshing.
 */
export function useReview(reviewId: string | undefined) {
  return useQuery({
    queryKey: keys.reviews.detail(reviewId ?? ""),
    queryFn: () => getReview(reviewId!),
    enabled: Boolean(reviewId),
    refetchInterval: (query) =>
      query.state.data && IN_FLIGHT.has(query.state.data.status) ? 3000 : false,
  });
}
