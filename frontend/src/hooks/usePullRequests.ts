import { useQuery } from "@tanstack/react-query";
import { listPullRequests } from "@/api/repos";
import { keys } from "./keys";

/**
 * A repository's pull requests, for the review picker.
 *
 * Proxied straight through to GitHub on every call rather than cached hard:
 * pull requests open and close constantly, and a picker showing one that was
 * merged an hour ago sends someone to review a diff that no longer matters.
 * Thirty seconds is long enough to survive flipping between the open and
 * closed tabs without re-fetching each time.
 */
export function usePullRequests(
  repoId: string | null,
  state: "open" | "closed" | "all",
) {
  return useQuery({
    queryKey: keys.repos.pulls(repoId ?? "", state),
    queryFn: () => listPullRequests(repoId!, state),
    enabled: Boolean(repoId),
    staleTime: 30_000,
  });
}
