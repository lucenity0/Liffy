import { apiClient } from "./client";
import type {
  ReviewDetailOut,
  ReviewListPage,
  ReviewStatus,
  TriggerAccepted,
} from "@/types/api";

export type ReviewSort = "newest" | "oldest";

export interface ListReviewsParams {
  limit?: number;
  offset?: number;
  repoId?: string;
  prNumber?: number;
  status?: ReviewStatus;
  sort?: ReviewSort;
}

export async function listReviews({
  limit = 20,
  offset = 0,
  repoId,
  prNumber,
  status,
  sort,
}: ListReviewsParams = {}): Promise<ReviewListPage> {
  const { data } = await apiClient.get<ReviewListPage>("/reviews", {
    // Unset filters are left out of the query string entirely rather than sent
    // empty. `repo_id=undefined` and `repo_id=null` reach FastAPI as the
    // literal strings, fail UUID parsing, and answer 422 — which on a list
    // page is a blank screen, not a field anyone can correct. Axios drops keys
    // whose value is `undefined`, so this relies on them being absent rather
    // than falsy: `prNumber: 0` would still be sent, and the backend's `gt=0`
    // is what rejects it.
    params: {
      limit,
      offset,
      repo_id: repoId,
      pr_number: prNumber,
      status,
      sort,
    },
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
