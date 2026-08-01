import { useQuery } from "@tanstack/react-query";
import { getRepoStatus } from "@/api/repos";
import { keys } from "./keys";

/**
 * Polls a single repo's index status every 5s until it flips to "indexed",
 * then stops. Nothing else tells the frontend indexing finished — there is
 * no webhook or socket — so the poll *is* the completion signal.
 *
 * `enabled` matters as much as the interval: GET /repos already returns
 * `indexed_at`, so the Dashboard only turns this on for repos where it is
 * null. Polling every repo unconditionally would be N requests every 5s,
 * forever, for repos that finished indexing weeks ago.
 *
 * v5 signature: refetchInterval receives the query, not (data, query).
 */
export function useRepoStatus(repoId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: keys.repos.status(repoId),
    queryFn: () => getRepoStatus(repoId),
    enabled: options?.enabled ?? true,
    refetchInterval: (query) =>
      query.state.data?.status === "indexing" ||
      query.state.data?.status === "not_indexed"
        ? 5000
        : false,
  });
}
