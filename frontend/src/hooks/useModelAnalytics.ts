import { useQuery } from "@tanstack/react-query";
import { getModelAnalytics } from "@/api/analytics";
import { keys } from "./keys";

/**
 * Per-model performance. Its own query, behind its own tab.
 *
 * Both aggregates it serves scan every completed review and every rating, so
 * loading it alongside the summary would make the tab nobody opened pay for
 * the one they did.
 */
export function useModelAnalytics(enabled: boolean) {
  return useQuery({
    queryKey: keys.analyticsModels.all,
    queryFn: getModelAnalytics,
    enabled,
  });
}
