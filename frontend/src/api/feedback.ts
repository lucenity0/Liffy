import { apiClient } from "./client";
import type { FeedbackOut } from "@/types/api";

/**
 * Rate a review comment. Real as of EVAL-1 (#190) — it writes a
 * `comment_feedback` row, and the rating is what report §8.1's approval rate
 * is computed from.
 *
 * Re-rating **replaces**: posting `1` then `-1` leaves one row at `-1`, so
 * switching sides needs no un-rate call. Posting the same value twice is
 * harmless but pointless — don't fire it.
 *
 * A rating outside `1 | -1` is a **422**, not a 200 with a status field. The
 * type here makes that unreachable from our own code, so treat the 422 as a
 * contract guard rather than a state the UI has to render. Note that
 * `normalizeApiError` reads `detail` only when it's a string, and FastAPI's
 * validation 422 sends an array — so it would fall through to the
 * connect-repo copy. Handle it locally if you handle it at all.
 *
 * 404 covers both "no such comment" and "not your review"; the API does not
 * distinguish them on purpose.
 */
export async function submitCommentFeedback(
  commentId: string,
  rating: 1 | -1,
): Promise<FeedbackOut> {
  const { data } = await apiClient.post<FeedbackOut>(
    `/comments/${commentId}/feedback`,
    { rating },
  );
  return data;
}
