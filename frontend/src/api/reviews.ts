import { apiClient } from "./client";
import type {
  CommitOut,
  LatestFindingOut,
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
  /**
   * Drop failed reviews from both the page and the total. Defaults to true
   * server-side, so omitting it keeps every existing caller's answer.
   */
  includeFailed?: boolean;
  sort?: ReviewSort;
}

export async function listReviews({
  limit = 20,
  offset = 0,
  repoId,
  prNumber,
  status,
  includeFailed,
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
      include_failed: includeFailed,
      sort,
    },
  });
  return data;
}

/**
 * The most recent finding worth showing, or `null` when there is not one yet.
 *
 * `null` is a 200 with a null body, not a 404 — an account that has not
 * produced a finding is ordinary, and a 404 here would make react-query treat
 * a healthy new install as a failed request.
 */
export async function getLatestFinding(): Promise<LatestFindingOut | null> {
  const { data } = await apiClient.get<LatestFindingOut | null>(
    "/reviews/latest-finding",
  );
  return data;
}

/**
 * Turn review-on-every-push on or off for one pull request.
 *
 * Addressed by pull request rather than by review: the setting outlives any
 * single review of it, and every later review reads the same flag.
 */
export async function setAutoReview(
  prId: string,
  enabled: boolean,
): Promise<{ pr_id: string; auto_review: boolean }> {
  const { data } = await apiClient.patch(`/prs/${prId}/auto-review`, { enabled });
  return data;
}

/** Commits on a pull request, each flagged with whether it is new since the review. */
export async function listPrCommits(prId: string): Promise<CommitOut[]> {
  const { data } = await apiClient.get<CommitOut[]>(`/prs/${prId}/commits`);
  return data;
}

/**
 * Review only the files the given commits touched.
 *
 * Returns 202 with no review id, like the other triggers — the caller
 * invalidates the list and lets polling surface the new row.
 */
export async function reviewCommits(
  prId: string,
  shas: string[],
): Promise<{ status: string; pr_number: number; commits: number }> {
  const { data } = await apiClient.post(`/prs/${prId}/review-commits`, { shas });
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
