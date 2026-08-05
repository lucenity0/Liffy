import {
  DEFAULT_APPEARANCE,
  parseAppearance,
  type AppearanceConfig,
} from "@/lib/theme/appearance";
import {
  buildCustomTheme,
  DEFAULT_SEEDS,
  TOKENS,
  type ThemeSeeds,
  type TokenName,
} from "@/lib/theme/derive";
import { isThemeId, type Polarity, type ThemeId } from "@/lib/themes";

/**
 * Saved themes — the thing that turns Appearance from a settings page into
 * somewhere you can experiment.
 *
 * The complaint this answers is specific: you could build one custom palette,
 * and building a second destroyed the first. `ThemePrefs.custom` is a single
 * slot by design — it is *the theme in use* — so rather than widening it into
 * an array and rewriting the boot script's storage contract, this is a second
 * key holding a library. Applying a saved theme copies it into the live slot;
 * saving copies the live slot back out. The boot script never learns this key
 * exists, which is why the pre-paint path stays as small as it is.
 *
 * Everything here is local to the browser. Liffy's backend holds one global
 * server configuration shared by everyone on the instance, and a personal
 * palette is not that — which is also why Export exists. Sharing a theme
 * means sending a file, not writing to a table someone else reads.
 */

export const LIBRARY_KEY = "liffy-themes";

/** Bumped only for a change old files cannot be read through. */
export const THEME_FILE_VERSION = 1;

export interface SavedTheme {
  id: string;
  name: string;
  /**
   * Which palette. A preset id keeps a saved theme following that preset —
   * so a Paper-based theme still tracks Paper if Paper is ever retuned —
   * while "custom" carries its own seeds below.
   */
  base: ThemeId;
  seeds: ThemeSeeds | null;
  overrides: Partial<Record<TokenName, string>>;
  appearance: AppearanceConfig;
  /** Populated on save; only ever used to order the list. */
  savedAt: number;
}

/**
 * Ids are content-free and generated here rather than from the name, so
 * renaming a theme does not orphan it and two themes called "Midnight" are
 * still two themes. `crypto.randomUUID` where it exists, with a fallback for
 * where it does not.
 *
 * That fallback is not only a jsdom concern: `randomUUID` is scoped to
 * secure contexts, so a self-hosted Liffy reached over plain HTTP at a LAN
 * address — a real deployment shape for this project, not a niche one —
 * falls through to it on every save. `counter` resets on every page load and
 * `TOKENS.length` is constant, so the old fallback produced the same
 * sequence of ids each time (`theme-1-19`, `theme-2-19`, …) — two themes
 * saved in different sessions could share an id, and every lookup keyed on
 * `candidate.id === saved.id` would then hit both. `Date.now()` and
 * `Math.random()` vary per session and per call, which a page-load counter
 * alone cannot.
 *
 * `derivedId` below is the one exception, and only for entries that reached
 * storage without an id at all — where being reproducible matters more than
 * being content-free.
 */
let counter = 0;
function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return (
    uuid ??
    `theme-${Date.now().toString(36)}-${(counter += 1)}-${Math.random().toString(36).slice(2, 8)}`
  );
}

/**
 * The id for an entry that arrived without one.
 *
 * Parsing is a read: it cannot write the repair back, which means the id it
 * invents has to be the *same* id the next time `read()` re-parses the same
 * bytes. `newId()` is stable for exactly one call, and `renameTheme`,
 * `deleteTheme` and `duplicateTheme` all `read()` again and match on
 * `theme.id === id` — so an entry handed out under a random id would silently
 * no-op against every one of them. Position in the stored array plus a hash
 * of the name is stable for as long as the entry is, and the first mutation
 * writes the repaired list back, at which point the id stops being derived
 * and starts being real.
 *
 * Only hand-edited or externally seeded storage reaches this: `saveTheme`
 * always writes an id.
 */
function derivedId(name: string, index: number): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return `theme-r${index}-${(hash >>> 0).toString(36)}`;
}

function read(): SavedTheme[] {
  try {
    return parseLibrary(localStorage.getItem(LIBRARY_KEY));
  } catch {
    // A blocked or partitioned store costs the library, not the app.
    return [];
  }
}

function write(themes: SavedTheme[]): void {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(themes));
  } catch {
    // Quota or a blocked store. The theme in use is unaffected — it lives
    // under the other key and was written before this ran.
  }
}

export function parseLibrary(raw: string | null): SavedTheme[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry, index) => parseSaved(entry, index))
      .filter((theme): theme is SavedTheme => theme !== null);
  } catch {
    return [];
  }
}

function parseSaved(value: unknown, index = 0): SavedTheme | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;

  const base = isThemeId(raw.base) ? raw.base : "custom";
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : derivedId(name, index),
    name: name.slice(0, 60),
    base,
    seeds: parseSeeds(raw.seeds),
    overrides: parseOverrides(raw.overrides),
    appearance: parseAppearance(raw.appearance),
    savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
  };
}

/** Shape only — the values are colours and the browser is the judge. */
function parseSeeds(value: unknown): ThemeSeeds | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const polarity: Polarity = raw.polarity === "light" ? "light" : "dark";
  const fallback = DEFAULT_SEEDS[polarity];
  const color = (key: keyof ThemeSeeds) =>
    typeof raw[key] === "string" ? (raw[key] as string) : (fallback[key] as string);

  return {
    polarity,
    surface: color("surface"),
    ink: color("ink"),
    oxide: color("oxide"),
    sage: color("sage"),
    ochre: color("ochre"),
    payne: color("payne"),
    ruleStrength:
      typeof raw.ruleStrength === "number" && Number.isFinite(raw.ruleStrength)
        ? Math.min(100, Math.max(0, raw.ruleStrength))
        : fallback.ruleStrength,
  };
}

function parseOverrides(value: unknown): Partial<Record<TokenName, string>> {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: Partial<Record<TokenName, string>> = {};
  for (const token of TOKENS) {
    const candidate = raw[token];
    // The same conservative shape the component editor holds colours to:
    // these are interpolated into a stylesheet, and an imported file is
    // somebody else's input.
    if (typeof candidate === "string" && /^#[0-9a-fA-F]{3,8}$/.test(candidate)) {
      out[token] = candidate;
    }
  }
  return out;
}

export function listThemes(): SavedTheme[] {
  return read().sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Saves the current look under a name, replacing a same-named theme.
 *
 * Replacing rather than accumulating "Midnight (2)": the button says Save,
 * and someone pressing it twice after an edit means the second one. Duplicate
 * is how you get two.
 */
export function saveTheme(
  theme: Omit<SavedTheme, "id" | "savedAt">,
  now: number,
): SavedTheme[] {
  const themes = read();
  const name = theme.name.trim().slice(0, 60) || "Untitled";
  const existing = themes.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );
  const saved: SavedTheme = {
    ...theme,
    name,
    id: existing?.id ?? newId(),
    savedAt: now,
  };
  const next = existing
    ? themes.map((candidate) => (candidate.id === saved.id ? saved : candidate))
    : [...themes, saved];
  write(next);
  return next;
}

export function renameTheme(id: string, name: string): SavedTheme[] {
  const clean = name.trim().slice(0, 60);
  if (!clean) return read();
  const next = read().map((theme) =>
    theme.id === id ? { ...theme, name: clean } : theme,
  );
  write(next);
  return next;
}

export function duplicateTheme(id: string, now: number): SavedTheme[] {
  const themes = read();
  const source = themes.find((theme) => theme.id === id);
  if (!source) return themes;
  const next = [
    ...themes,
    { ...source, id: newId(), name: uniqueName(themes, `${source.name} copy`), savedAt: now },
  ];
  write(next);
  return next;
}

export function deleteTheme(id: string): SavedTheme[] {
  const next = read().filter((theme) => theme.id !== id);
  write(next);
  return next;
}

function uniqueName(themes: SavedTheme[], wanted: string): string {
  const taken = new Set(themes.map((theme) => theme.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${wanted} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return wanted;
}

/**
 * The export format.
 *
 * Written out in full rather than as a diff from the defaults: a theme file
 * is something you send to someone whose Liffy may be a different version,
 * and "everything, explicitly" survives that where "only what differs" needs
 * both sides to agree on what the defaults were. It is JSON with real field
 * names for the same reason — it should be legible, and editable, in a text
 * editor.
 */
export interface ThemeFile {
  liffy: number;
  name: string;
  base: ThemeId;
  seeds: ThemeSeeds | null;
  overrides: Partial<Record<TokenName, string>>;
  appearance: AppearanceConfig;
}

export function exportTheme(theme: SavedTheme): string {
  const file: ThemeFile = {
    liffy: THEME_FILE_VERSION,
    name: theme.name,
    base: theme.base,
    seeds: theme.seeds,
    overrides: theme.overrides,
    appearance: theme.appearance,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Reads a theme file, and says why if it cannot.
 *
 * Returns the reason rather than throwing because every caller is a file
 * picker that has to put something on screen — and "that is not a Liffy
 * theme" is a more useful thing to show than a caught SyntaxError.
 */
export function importTheme(
  text: string,
): { ok: true; theme: Omit<SavedTheme, "id" | "savedAt"> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "That file is not a Liffy theme." };
  }

  const raw = parsed as Record<string, unknown>;
  if (typeof raw.liffy !== "number") {
    return { ok: false, error: "That file is not a Liffy theme — no version field." };
  }
  if (raw.liffy > THEME_FILE_VERSION) {
    return {
      ok: false,
      error: `That theme was written by a newer Liffy (format ${raw.liffy}, this one reads ${THEME_FILE_VERSION}).`,
    };
  }

  const saved = parseSaved({ ...raw, name: raw.name ?? "Imported" });
  if (!saved) return { ok: false, error: "That theme has no name." };

  return {
    ok: true,
    theme: {
      name: saved.name,
      base: saved.base,
      seeds: saved.seeds,
      overrides: saved.overrides,
      appearance: saved.appearance,
    },
  };
}

/**
 * The colour half of a saved theme, ready for `saveCustom`.
 *
 * Returns null for a preset-based theme — those apply by id and have no
 * palette of their own to install.
 */
export function customFromSaved(theme: SavedTheme) {
  if (theme.base !== "custom" || !theme.seeds) return null;
  return buildCustomTheme(theme.seeds, theme.overrides);
}

/** A blank entry, for "Save current" before anything has been named. */
export function draftTheme(
  base: ThemeId,
  seeds: ThemeSeeds | null,
  overrides: Partial<Record<TokenName, string>>,
  appearance: AppearanceConfig = DEFAULT_APPEARANCE,
): Omit<SavedTheme, "id" | "savedAt"> {
  return { name: "", base, seeds, overrides, appearance };
}
