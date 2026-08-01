import { apiClient } from "./client";
import type { EvalScoresOut } from "@/types/api";

/**
 * Reads of computed evaluation scores — report §8.1's numbers, as opposed to
 * the review rows themselves.
 *
 * Separate from `reviews.ts` because these are derived figures rather than
 * resources, and separate from `feedback.ts` because that file writes. #200
 * adds `getAnalyticsSummary` alongside this one.
 */

/**
 * Per-review approval scores.
 *
 * A 404 means the review is gone (or belongs to somebody else — the API does
 * not distinguish them, same as everywhere else). It does **not** mean the
 * score is zero; let the caller's error handling take it.
 */
export async function getReviewEval(reviewId: string): Promise<EvalScoresOut> {
  const { data } = await apiClient.get<EvalScoresOut>(
    `/reviews/${reviewId}/eval`,
  );
  return data;
}
