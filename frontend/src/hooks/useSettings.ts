import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "@/api/settings";
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
