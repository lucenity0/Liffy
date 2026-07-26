import { apiClient } from "./client";

/**
 * The backend endpoint is a stub (no DB) — it always returns 200 with
 * `status: "saved" | "invalid"` rather than a 422 for a bad rating. The
 * wrapper mirrors that rather than pretending it's a proper mutation.
 */
export async function submitCommentFeedback(
  commentId: string,
  rating: 1 | -1,
): Promise<{ comment_id: string; status: string; rating: number }> {
  const { data } = await apiClient.post(`/comments/${commentId}/feedback`, { rating });
  return data;
}
