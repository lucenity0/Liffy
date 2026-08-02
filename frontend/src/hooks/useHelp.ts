import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { getHelpPage, getHelpTopics, searchHelp, submitReport } from "@/api/help";
import { keys } from "./keys";

/** Common questions and the table of contents. Never changes between deploys. */
export function useHelpTopics() {
  return useQuery({
    queryKey: keys.help.topics(),
    queryFn: getHelpTopics,
    staleTime: Infinity,
  });
}

/**
 * Search results for a query, or nothing while the box is empty.
 *
 * `keepPreviousData` is what stops the reading pane blinking to empty between
 * keystrokes: the previous matches stay on screen until the next set arrives,
 * so typing feels like filtering rather than like repeatedly clearing the page.
 *
 * `staleTime: Infinity` because the corpus is static — going back to a query
 * you already ran should be instant and should not re-hit the API.
 */
export function useHelpSearch(query: string) {
  const trimmed = query.trim();

  return useQuery({
    queryKey: keys.help.search(trimmed),
    queryFn: () => searchHelp(trimmed),
    enabled: trimmed.length > 0,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
}

/**
 * One page by slug, for a deep link whose page is not in the current results.
 *
 * `/help?q=claude+not+on+PATH&page=subscription-providers` has to render the
 * page it names even when that page did not rank for that query — otherwise a
 * shared link quietly shows whatever happened to rank first, which is a
 * different answer wearing the right URL. Only runs when the fallback is
 * actually needed.
 */
export function useHelpPage(slug: string | null, enabled: boolean) {
  return useQuery({
    queryKey: keys.help.page(slug ?? ""),
    queryFn: () => getHelpPage(slug!),
    enabled: enabled && !!slug,
    staleTime: Infinity,
  });
}

/**
 * Files the report. Nothing is cached or invalidated — an issue lives on
 * GitHub, and Liffy holds no list of them to keep fresh.
 */
export function useSubmitReport() {
  return useMutation({ mutationFn: submitReport });
}
