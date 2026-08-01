import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  connectSecret,
  disconnectSecret,
  getSettings,
  updateSettings,
} from "@/api/settings";
import { keys } from "./keys";

export function useSettings() {
  return useQuery({
    queryKey: keys.settings.all,
    queryFn: getSettings,
  });
}

/**
 * PATCH returns the full settings document, so the cache is *set* from the
 * response rather than invalidated and refetched.
 *
 * That matters more than the saved request. A setting's `source` flips from
 * "env" to "changed here" as part of the same write, and an invalidate-then-
 * refetch would show the new value beside the old provenance for a frame —
 * a page whose whole job is explaining where values come from should not
 * flicker through a wrong answer.
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (values: Record<string, string>) => updateSettings(values),
    onSuccess: (data) => queryClient.setQueryData(keys.settings.all, data),
  });
}

/**
 * Connecting and disconnecting a credential.
 *
 * Same cache treatment as the PATCH: the response is the authoritative
 * document, so it is set rather than invalidated. Here the stake is higher —
 * the badge this drives is the answer to "is my account connected?", and
 * flickering through a stale "Not configured" after a successful connect is
 * exactly the confusion the flow exists to remove.
 */
export function useConnectSecret() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      connectSecret(key, value),
    onSuccess: (data) => queryClient.setQueryData(keys.settings.all, data),
  });
}

export function useDisconnectSecret() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (key: string) => disconnectSecret(key),
    onSuccess: (data) => queryClient.setQueryData(keys.settings.all, data),
  });
}
