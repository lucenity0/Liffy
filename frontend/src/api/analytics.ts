import { apiClient } from "./client";
import type {
  ActivityOut,
  ModelAnalyticsOut,
  AnalyticsSummaryOut,
  EvalScoresOut,
} from "@/types/api";

/**
 * Reads of computed evaluation scores — report §8.1's numbers, as opposed to
 * the review rows themselves.
 *
 * Separate from `reviews.ts` because these are derived figures rather than
 * resources, and separate from `feedback.ts` because that file writes.
 */

/**
 * Every §8.1 metric in one request, scoped to the caller's repositories.
 *
 * A brand-new account is a **200 with zeros and nulls**, not a 404 and not an
 * error — so the only failures worth handling here are auth and transport.
 * Not cached server-side: a stale dashboard during a demo is worse than a
 * slow one.
 */
export async function getAnalyticsSummary(): Promise<AnalyticsSummaryOut> {
  const { data } = await apiClient.get<AnalyticsSummaryOut>("/analytics/summary");
  return data;
}

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

/**
 * The dashboard's opening figures, over the last `days`.
 *
 * Its own route rather than fields on the summary: this loads on the app's
 * most-visited screen, and the summary computes every §8.1 rate plus the
 * flagged-review list to answer questions only the analytics page asks.
 */
export async function getActivity(days: number): Promise<ActivityOut> {
  const { data } = await apiClient.get<ActivityOut>("/analytics/activity", {
    params: { days },
  });
  return data;
}

export async function getModelAnalytics(): Promise<ModelAnalyticsOut> {
  const { data } = await apiClient.get<ModelAnalyticsOut>("/analytics/models");
  return data;
}
