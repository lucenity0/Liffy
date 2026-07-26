import { useMutation, useQueryClient } from "@tanstack/react-query";
import { connectRepo, disconnectRepo, triggerIndex } from "@/api/repos";
import { keys } from "./keys";

/**
 * All three invalidate `keys.repos.all` rather than `keys.repos.list()`,
 * because the prefix also catches every per-repo status query underneath —
 * a freshly connected or re-indexed repo needs its status refetched, not
 * just the list row.
 */

export function useConnectRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (fullName: string) => connectRepo(fullName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.repos.all }),
  });
}

export function useTriggerIndex() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (repoId: string) => triggerIndex(repoId),
    onSuccess: (_data, repoId) => {
      // The repo just went back to not_indexed, which restarts its poll.
      queryClient.invalidateQueries({ queryKey: keys.repos.status(repoId) });
      queryClient.invalidateQueries({ queryKey: keys.repos.list() });
    },
  });
}

export function useDisconnectRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (repoId: string) => disconnectRepo(repoId),
    onSuccess: (_data, repoId) => {
      // Drop the dead repo's status query outright — invalidating it would
      // refetch a 404 for a repo that no longer exists.
      queryClient.removeQueries({ queryKey: keys.repos.status(repoId) });
      queryClient.invalidateQueries({ queryKey: keys.repos.list() });
    },
  });
}
