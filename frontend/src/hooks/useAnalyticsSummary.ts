import { useQuery } from "@tanstack/react-query";
import { getAnalyticsSummary } from "@/api/analytics";
import { keys } from "./keys";

/**
 * Report §8.1's numbers for the whole account.
 *
 * No poll. Every figure here moves when a review finishes or somebody rates a
 * comment, both of which are minutes-to-days apart — a 5s interval would be
 * one request per user per 5s, forever, to redraw the same page.
 */
export function useAnalyticsSummary() {
  return useQuery({
    queryKey: keys.analytics.summary(),
    queryFn: getAnalyticsSummary,
  });
}
