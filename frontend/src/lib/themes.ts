/**
 * The theme registry — the one list every other surface reads.
 *
 * Adding a theme is two edits: an entry here, and a `[data-theme="…"]` block
 * in index.css. Nothing else enumerates themes: the picker maps over THEMES,
 * Monaco builds its editor theme from whichever id is active, and the style
 * guide audits every entry. Widening a union in five files is exactly the
 * failure this replaces.
 *
 * The one unavoidable duplicate is the boot script in index.html, which has
 * to run before any module loads and therefore cannot import this. It needs
 * only the id → polarity and id → colour maps; keep them in step.
 */

export type ThemeId = "paper" | "graphite";

/** Light or dark. Distinct from the theme itself — five themes, two of these. */
export type Polarity = "light" | "dark";

export interface ThemeSpec {
  id: ThemeId;
  /** Shown in the picker. */
  label: string;
  /** One line on what the theme is for, shown under the label. */
  note: string;
  polarity: Polarity;
  /** `<meta name="theme-color">`; always the theme's own `--paper`. */
  color: string;
}

/**
 * Ordered as the picker shows them: light themes first, then dark, each
 * group running soft → deep.
 */
export const THEMES: readonly ThemeSpec[] = [
  {
    id: "paper",
    label: "Paper",
    note: "Warm cream, hairline rules",
    polarity: "light",
    color: "#f0ece3",
  },
  {
    id: "graphite",
    label: "Graphite",
    note: "Soft warm dark",
    polarity: "dark",
    color: "#1d1b18",
  },
];

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && BY_ID.has(value as ThemeId);
}

export function themeSpec(id: ThemeId): ThemeSpec {
  // Non-null: ThemeId is derived from THEMES, so every id has a spec.
  return BY_ID.get(id)!;
}

export function polarityOf(id: ThemeId): Polarity {
  return themeSpec(id).polarity;
}

export function themesByPolarity(polarity: Polarity): readonly ThemeSpec[] {
  return THEMES.filter((t) => t.polarity === polarity);
}

/**
 * The defaults a first-time visitor gets.
 *
 * DEFAULT_THEME is what lands with no stored preference at all. It is a
 * deliberate choice rather than "follow the OS": Liffy's default look is the
 * dark one, and "Match system" is one click away in the picker. Anyone who
 * had already chosen keeps their choice — the migration in useTheme reads the
 * old plain-string value rather than discarding it.
 */
export const DEFAULT_THEME: ThemeId = "graphite";
export const DEFAULT_LIGHT: ThemeId = "paper";
export const DEFAULT_DARK: ThemeId = "graphite";
