import { useCallback, useSyncExternalStore } from "react";

/**
 * The theme, read from and written to the DOM.
 *
 * `<html class="dark">` is the state, not React — the boot script in
 * index.html sets it synchronously before first paint, which is the whole
 * point: a value that lived in a context would apply one render *after* the
 * page is already visible, and the flash is the thing being avoided.
 *
 * Three unrelated consumers read this (TopBar, the style guide, the Monaco
 * diff), so it syncs through useSyncExternalStore over a module-level
 * listener set rather than a provider. The DOM stays the source of truth and
 * the subscription is only how components hear about a change.
 */

export type Theme = "paper" | "graphite";

/** Kept in sync with the boot script in index.html — change both together. */
export const THEME_KEY = "liffy-theme";

const THEME_COLOR: Record<Theme, string> = {
  paper: "#f4f1ea",
  graphite: "#1d1b18",
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // Follow the OS while the user has expressed no preference of their own.
  const query = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onSystemChange = (event: MediaQueryListEvent) => {
    if (readStored() === null) apply(event.matches ? "graphite" : "paper");
  };
  query?.addEventListener?.("change", onSystemChange);

  return () => {
    listeners.delete(listener);
    query?.removeEventListener?.("change", onSystemChange);
  };
}

function getSnapshot(): Theme {
  return document.documentElement.classList.contains("dark")
    ? "graphite"
    : "paper";
}

/** null when the user has never chosen, which is what defers to the OS. */
function readStored(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "graphite" || stored === "paper" ? stored : null;
  } catch {
    return null;
  }
}

/** The DOM half of a theme change, without touching localStorage. */
function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "graphite");

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[theme]);

  emit();
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot);

  const setTheme = useCallback((next: Theme) => {
    // Persisted even when it matches the OS: the point of the click is to
    // pin the choice, so a later OS flip must not undo it.
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Blocked storage costs persistence, not the theme itself.
    }
    apply(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(getSnapshot() === "graphite" ? "paper" : "graphite");
  }, [setTheme]);

  return { theme, setTheme, toggle };
}
