import { useQuery } from "@tanstack/react-query";
import { getLatestFinding } from "@/api/reviews";
import { keys } from "./keys";

/**
 * The one finding the dashboard leads with.
 *
 * No `refetchInterval`: this is a showcase, not a status. A row that
 * rewrites itself under the reader every few seconds is worse than one that
 * is a minute stale, and the reviews list below it is already the live view.
 */
export function useLatestFinding() {
  return useQuery({
    queryKey: keys.reviews.latestFinding(),
    queryFn: getLatestFinding,
  });
}
