import { useEffect } from "react";

/**
 * Keeps the browser tab in sync with the route. `usePageTitle` reads the
 * title out of the route handle for display; this one puts it in the tab.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title === "Liffy" ? "Liffy" : `${title} · Liffy`;
  }, [title]);
}
