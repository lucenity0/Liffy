import { apiClient } from "./client";
import type { HelpIndexOut, HelpPassage, HelpSearchOut } from "@/types/api";

/** Ranked passages for a question. An empty `results` is a result, not an error. */
export async function searchHelp(q: string): Promise<HelpSearchOut> {
  const { data } = await apiClient.get<HelpSearchOut>("/help", {
    params: { q },
  });
  return data;
}

/** Common questions and the whole table of contents, for the empty state. */
export async function getHelpTopics(): Promise<HelpIndexOut> {
  const { data } = await apiClient.get<HelpIndexOut>("/help/topics");
  return data;
}

/** One page by slug — what a deep link resolves. Null when the slug is stale. */
export async function getHelpPage(slug: string): Promise<HelpPassage | null> {
  const { data } = await apiClient.get<HelpPassage | null>(`/help/${slug}`);
  return data;
}
