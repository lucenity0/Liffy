import { apiClient } from "./client";
import type { ReviewDetailOut, ReviewListItem, TriggerAccepted } from "@/types/api";

export interface ListReviewsParams {
  limit?: number;
  offset?: number;
}

export async function listReviews({
  limit = 20,
  offset = 0,
}: ListReviewsParams = {}): Promise<ReviewListItem[]> {
  const { data } = await apiClient.get<ReviewListItem[]>("/reviews", {
    params: { limit, offset },
  });
  return data;
}

export async function getReview(reviewId: string): Promise<ReviewDetailOut> {
  const { data } = await apiClient.get<ReviewDetailOut>(`/reviews/${reviewId}`);
  return data;
}

export async function getPrReview(prId: string): Promise<ReviewDetailOut> {
  const { data } = await apiClient.get<ReviewDetailOut>(`/prs/${prId}/review`);
  return data;
}

/**
 * 202 body is `{status, repo, pr_number}` — deliberately no review id.
 * Callers cannot deep-link to the review this creates; land on the list and
 * let its own polling surface the new row.
 */
export async function triggerReview(params: {
  owner: string;
  repo: string;
  pr_number: number;
}): Promise<TriggerAccepted> {
  const { data } = await apiClient.post<TriggerAccepted>("/reviews/trigger", params);
  return data;
}

/**
 * Re-runs the pipeline for the PR behind an existing review. This creates a
 * *new* review row rather than updating `reviewId` in place — the caller
 * must navigate to the list, not expect this review to refresh itself.
 */
export async function rereview(reviewId: string): Promise<TriggerAccepted> {
  const { data } = await apiClient.post<TriggerAccepted>(`/reviews/${reviewId}/trigger`);
  return data;
}
