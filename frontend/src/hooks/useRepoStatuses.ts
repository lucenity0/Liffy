import { useQueries } from "@tanstack/react-query";
import { getRepoStatus } from "@/api/repos";
import type { RepoStatusOut } from "@/types/api";
import { keys } from "./keys";

/**
 * Every repository's index status, as one hook call.
 *
 * `useRepoStatus` is per-repo, which forced a component per row — fine when
 * each row only needs its own status. The repositories list needs them
 * *collectively*: the summary strip counts them and the filters partition by
 * them, and neither can be computed from inside the rows.
 *
 * Same query keys and the same stop-when-indexed poll as `useRepoStatus`, so
 * a status already fetched by the dashboard is served from cache rather than
 * re-requested, and the two never disagree about a repo.
 */
export function useRepoStatuses(repoIds: string[]) {
  return useQueries({
    queries: repoIds.map((repoId) => ({
      queryKey: keys.repos.status(repoId),
      queryFn: () => getRepoStatus(repoId),
      refetchInterval: (query: {
        state: { data?: RepoStatusOut };
      }) =>
        query.state.data?.status === "indexing" ||
        query.state.data?.status === "not_indexed"
          ? 5000
          : (false as const),
    })),
    combine: (results) => ({
      // Keyed by id rather than returned positionally: the rows are filtered
      // and sorted after this, so an index into the original array stops
      // meaning anything the moment a filter is applied.
      byId: new Map(
        results.flatMap((result, index) =>
          result.data ? [[repoIds[index], result.data] as const] : [],
        ),
      ),
      isPending: results.some((result) => result.isPending),
    }),
  });
}
