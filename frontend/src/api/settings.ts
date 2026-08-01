import { apiClient } from "./client";
import type { SettingsOut } from "@/types/api";

export async function getSettings(): Promise<SettingsOut> {
  const { data } = await apiClient.get<SettingsOut>("/settings");
  return data;
}

/**
 * A partial update: only the keys present are touched.
 *
 * Values go up as strings whatever their type, matching the backend, so the
 * one parser on that side — `SettingSpec.parse` — stays the single path from
 * text to a live value. Sending a JSON `true` for the booleans and a string
 * for everything else would give the same column two different routes in.
 *
 * Returns the whole settings document, so the caller re-renders from the
 * server's view rather than an optimistic guess about what it just changed.
 */
export async function updateSettings(
  values: Record<string, string>,
): Promise<SettingsOut> {
  const { data } = await apiClient.patch<SettingsOut>("/settings", { values });
  return data;
}
