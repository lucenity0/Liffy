import { useCallback, useSyncExternalStore } from "react";
import {
  appearanceAttrs,
  appearanceCss,
  DEFAULT_APPEARANCE,
  parseAppearance,
  type AppearanceConfig,
} from "@/lib/theme/appearance";

/**
 * The workspace shape, read from and written to the DOM.
 *
 * Same contract as useTheme, for the same reason: the boot script in
 * index.html has to have this on the page before first paint, so the DOM is
 * the state and React only subscribes to it. A context would apply one render
 * after the page is visible, which for UI Scale means every page reflowing
 * once on load.
 *
 * There is no draft and no Save button. Changes land the instant you make
 * them, exactly as the colour picker on this page already worked — this is a
 * preference in your browser, not server configuration behind a PATCH, and
 * giving it a Save button would imply your team sees it. Experiments are
 * recoverable through the theme library rather than through a dirty buffer:
 * Reset returns to the defaults and a saved theme returns to wherever you
 * were, which is a better answer than Cancel because it survives a reload.
 */

/** Kept in sync with the boot script in index.html — change both together. */
export const APPEARANCE_KEY = "liffy-appearance";

/**
 * The resolved stylesheet, cached beside the config.
 *
 * Redundant on purpose, and the same bargain `CustomTheme.tokens` already
 * strikes: the boot script has to write these variables before first paint
 * and cannot import `appearanceVars`, so the choice is a cached result or a
 * second implementation of the whole mapping in inline ES5. A cache with one
 * writer — `applyAppearance`, below — is the cheaper duplicate, and the one
 * that cannot drift in a way anybody has to reason about.
 *
 * The config under APPEARANCE_KEY stays the source of truth: it is what
 * exports, imports and the UI read. This key is never read by anything but
 * the boot script.
 */
export const APPEARANCE_CSS_KEY = "liffy-appearance-css";

/** The <style> element the workspace variables are injected into. */
const APPEARANCE_STYLE_ID = "liffy-appearance";

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function readAppearance(): AppearanceConfig {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    return raw ? parseAppearance(JSON.parse(raw)) : DEFAULT_APPEARANCE;
  } catch {
    // Blocked storage, or something that is not JSON. Neither is worth a
    // page that will not render.
    return DEFAULT_APPEARANCE;
  }
}

function writeConfig(config: AppearanceConfig) {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(config));
  } catch {
    // Blocked storage costs persistence, not the setting itself.
  }
}

/**
 * The DOM half, without touching localStorage.
 *
 * A dedicated <style> rather than inline properties on <html>: the style
 * attribute is shared with anything else that might write to it, and a real
 * rule can carry the component overrides, which are selectors rather than
 * values and have nowhere else to live.
 */
export function applyAppearance(config: AppearanceConfig): void {
  const root = document.documentElement;
  const css = appearanceCss(config);

  const existing = document.getElementById(APPEARANCE_STYLE_ID);
  const style = existing ?? document.createElement("style");
  style.id = APPEARANCE_STYLE_ID;
  style.textContent = css;
  if (!existing) document.head.appendChild(style);

  for (const [name, value] of Object.entries(appearanceAttrs(config))) {
    root.setAttribute(name, value);
  }

  try {
    localStorage.setItem(APPEARANCE_CSS_KEY, css);
  } catch {
    // Only costs the next load its pre-paint pass, not this one.
  }

  emit();
}

/**
 * A snapshot React can compare.
 *
 * Reads storage rather than the DOM, unlike useTheme's — the DOM carries the
 * *resolved* variables and there is no way back from `--ui-density: 0.88` to
 * "Compact" without restating the table. Storage holds the config itself, so
 * it is the cheaper source. The string is cached so `useSyncExternalStore`
 * gets a stable identity between renders; parsing it every render would
 * return a fresh object each time and loop.
 */
let cachedRaw: string | null = null;
let cachedConfig: AppearanceConfig = DEFAULT_APPEARANCE;

function readRaw(): string | null {
  try {
    return localStorage.getItem(APPEARANCE_KEY);
  } catch {
    return null;
  }
}

function getSnapshot(): AppearanceConfig {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedConfig = readAppearance();
  }
  return cachedConfig;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // The other tabs. Settings open beside a dashboard is the case this page
  // is built for, so a change here reaching there is not a nicety.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== APPEARANCE_KEY) return;
    applyAppearance(readAppearance());
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppearance() {
  const config = useSyncExternalStore(subscribe, getSnapshot);

  /** Change one field. Lands immediately, in this tab and every other one. */
  const update = useCallback((patch: Partial<AppearanceConfig>) => {
    const next = { ...readAppearance(), ...patch };
    writeConfig(next);
    applyAppearance(next);
  }, []);

  /** Install a config wholesale — applying a saved theme, or importing one. */
  const replace = useCallback((next: AppearanceConfig) => {
    writeConfig(next);
    applyAppearance(next);
  }, []);

  const reset = useCallback(() => {
    writeConfig(DEFAULT_APPEARANCE);
    applyAppearance(DEFAULT_APPEARANCE);
  }, []);

  return { config, update, replace, reset };
}
