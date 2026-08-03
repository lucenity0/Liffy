import { useQuery } from "@tanstack/react-query";
import { getActivity } from "@/api/analytics";
import { keys } from "./keys";

/** The default window, and the one the dashboard heading is written for. */
export const ACTIVITY_DAYS = 7;

/**
 * What Liffy did over the last `days`.
 *
 * No poll, for the same reason `useAnalyticsSummary` has none: every figure
 * here moves when a review finishes, which is minutes to days apart. An
 * interval would be one request per user forever to redraw the same three
 * numbers.
 */
export function useActivity(days: number = ACTIVITY_DAYS) {
  return useQuery({
    queryKey: keys.analytics.activity(days),
    queryFn: () => getActivity(days),
  });
}
