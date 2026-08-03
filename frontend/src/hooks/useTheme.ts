import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  DEFAULT_THEME,
  isThemeId,
  polarityOf,
  themeSpec,
  type ThemeId,
} from "@/lib/themes";

/**
 * The theme, read from and written to the DOM.
 *
 * `<html data-theme="…">` is the state, not React — the boot script in
 * index.html sets it synchronously before first paint, which is the whole
 * point: a value that lived in a context would apply one render *after* the
 * page is already visible, and the flash is the thing being avoided.
 *
 * Several unrelated consumers read this (the nav, the style guide, the Monaco
 * diff), so it syncs through useSyncExternalStore over a module-level
 * listener set rather than a provider. The DOM stays the source of truth and
 * the subscription is only how components hear about a change.
 */

/** Kept in sync with the boot script in index.html — change both together. */
export const THEME_KEY = "liffy-theme";

/**
 * What lives under THEME_KEY.
 *
 * `mode: "system"` follows prefers-color-scheme, picking `light` or `dark`
 * from this same object — so "match my OS" and "which dark theme do I want"
 * stay independent questions. `mode: "fixed"` pins `theme` outright.
 */
export interface ThemePrefs {
  mode: "system" | "fixed";
  theme: ThemeId;
  light: ThemeId;
  dark: ThemeId;
}

const DEFAULTS: ThemePrefs = {
  mode: "fixed",
  theme: DEFAULT_THEME,
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK,
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/**
 * Parses whatever is in storage, including what previous versions wrote.
 *
 * Before the theme ladder this key held a bare `"paper"` or `"graphite"`.
 * Those are read as a pinned choice rather than discarded: someone who had
 * already picked a side should not be moved onto the new default because the
 * storage format changed under them. The docs pages still write bare strings
 * too, so this is a live format, not only a historical one.
 */
export function parsePrefs(raw: string | null): ThemePrefs {
  if (!raw) return DEFAULTS;

  if (isThemeId(raw)) {
    return { ...DEFAULTS, mode: "fixed", theme: raw };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULTS;
    const p = parsed as Partial<ThemePrefs>;
    return {
      mode: p.mode === "system" ? "system" : "fixed",
      theme: isThemeId(p.theme) ? p.theme : DEFAULTS.theme,
      light: isThemeId(p.light) ? p.light : DEFAULTS.light,
      dark: isThemeId(p.dark) ? p.dark : DEFAULTS.dark,
    };
  } catch {
    // A theme preference is never worth throwing over.
    return DEFAULTS;
  }
}

/** Which theme a set of preferences resolves to right now. */
export function resolveTheme(prefs: ThemePrefs, systemDark: boolean): ThemeId {
  if (prefs.mode === "system") return systemDark ? prefs.dark : prefs.light;
  return prefs.theme;
}

function readPrefs(): ThemePrefs {
  try {
    return parsePrefs(localStorage.getItem(THEME_KEY));
  } catch {
    return DEFAULTS;
  }
}

function writePrefs(prefs: ThemePrefs) {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(prefs));
  } catch {
    // Blocked storage costs persistence, not the theme itself.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // Follow the OS, but only while the user has asked us to.
  const query = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onSystemChange = (event: MediaQueryListEvent) => {
    const prefs = readPrefs();
    if (prefs.mode === "system") {
      apply(resolveTheme(prefs, event.matches));
    }
  };
  query?.addEventListener?.("change", onSystemChange);

  return () => {
    listeners.delete(listener);
    query?.removeEventListener?.("change", onSystemChange);
  };
}

function getSnapshot(): ThemeId {
  const attr = document.documentElement.dataset.theme;
  return isThemeId(attr) ? attr : DEFAULT_THEME;
}

/** The DOM half of a theme change, without touching localStorage. */
function apply(theme: ThemeId) {
  const root = document.documentElement;
  const polarity = polarityOf(theme);

  root.dataset.theme = theme;
  // Polarity as a class as well as an attribute: `@custom-variant dark` keys
  // off it, and it lets anything branch on light-vs-dark without having to
  // know the name of every dark theme.
  root.classList.toggle("dark", polarity === "dark");
  root.classList.toggle("light", polarity === "light");

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", themeSpec(theme).color);

  emit();
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot);

  /** Pin a theme. Also records it as the preferred theme of its polarity. */
  const setTheme = useCallback((next: ThemeId) => {
    const prefs = readPrefs();
    writePrefs({
      ...prefs,
      mode: "fixed",
      theme: next,
      // Remembered per side, so a later "match system" picks up the themes
      // actually chosen rather than resetting to the defaults.
      [polarityOf(next)]: next,
    });
    apply(next);
  }, []);

  /** Hand the choice back to the OS, keeping the per-side preferences. */
  const matchSystem = useCallback(() => {
    const prefs = { ...readPrefs(), mode: "system" as const };
    writePrefs(prefs);
    apply(resolveTheme(prefs, prefersDark()));
  }, []);

  /**
   * Flip to the other polarity, landing on whichever theme was last used on
   * that side. The top-bar affordance; the picker is where a specific theme
   * gets chosen.
   */
  const toggle = useCallback(() => {
    const prefs = readPrefs();
    const next = polarityOf(getSnapshot()) === "dark" ? prefs.light : prefs.dark;
    setTheme(next);
  }, [setTheme]);

  return {
    theme,
    polarity: polarityOf(theme),
    prefs: readPrefs(),
    setTheme,
    matchSystem,
    toggle,
  };
}
