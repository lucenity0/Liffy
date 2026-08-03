import type { Polarity } from "@/lib/themes";

/**
 * A custom theme, from a handful of seeds.
 *
 * Every preset in index.css is ~20 raw custom properties, and hand-picking
 * twenty colours is how you get a palette that is technically yours and
 * unreadable. So the editor exposes the five decisions that actually differ
 * between the presets, and derives the rest the way index.css already does —
 * `color-mix()` expressions, not resolved hex, so the browser does the work
 * and a custom theme has exactly the same shape as a built-in one.
 */

export interface ThemeSeeds {
  polarity: Polarity;
  /** The page. Everything else is positioned relative to it. */
  surface: string;
  /** Primary text. */
  ink: string;
  /** 0–100. How far the hairlines sit from the surface. */
  ruleStrength: number;
  oxide: string;
  sage: string;
  ochre: string;
  payne: string;
}

export const DEFAULT_SEEDS: Record<Polarity, ThemeSeeds> = {
  light: {
    polarity: "light",
    surface: "#f0ece3",
    ink: "#2b2925",
    ruleStrength: 45,
    oxide: "#9a3f2b",
    sage: "#456646",
    ochre: "#775b17",
    payne: "#3b5670",
  },
  dark: {
    polarity: "dark",
    surface: "#12171a",
    ink: "#e8e9e4",
    ruleStrength: 45,
    oxide: "#e2846a",
    sage: "#84b184",
    ochre: "#d0ab52",
    payne: "#88b4d4",
  },
};

/** Every token a theme block may set. Also the Advanced editor's field list. */
export const TOKENS = [
  "paper",
  "card",
  "recessed",
  "rule",
  "rule-strong",
  "shadow-edge",
  "ink",
  "ink-dim",
  "ink-sub",
  "oxide",
  "sage",
  "ochre",
  "payne",
  "neutral-tint",
  "chrome",
  "chrome-ink",
  "chrome-ink-dim",
  "chrome-rule",
  "chrome-active",
] as const;

export type TokenName = (typeof TOKENS)[number];

/** `color-mix(in oklab, a p%, b)` — the same expression index.css uses. */
const mix = (a: string, percent: number, b: string) =>
  `color-mix(in oklab, ${a} ${Math.round(percent)}%, ${b})`;

/**
 * Seeds → the full token set.
 *
 * Direction is the one thing polarity decides. Under a light theme the card
 * is *lighter* than the page and the recess darker; under a dark theme the
 * card is lighter too — elevation reads as "closer to the eye" either way,
 * which is why this mixes toward ink or toward white rather than simply
 * inverting.
 */
export function deriveTokens(seeds: ThemeSeeds): Record<TokenName, string> {
  const { surface, ink, polarity } = seeds;
  const dark = polarity === "dark";

  // What "away from the surface" means. Lifting a dark surface needs a light
  // to lift it toward, and the ink is the only other colour in play.
  const lift = dark ? ink : "#ffffff";
  const sink = dark ? "#000000" : ink;

  // 0–100 mapped onto the range the presets actually occupy: paper's rule is
  // ~22% of the way from surface to ink, bond's ~55%. Below ~15% a hairline
  // stops being visible at all, which is the bug this whole exercise began
  // with, so the floor is deliberate.
  const rulePercent = 15 + (seeds.ruleStrength / 100) * 45;

  return {
    paper: surface,
    card: mix(lift, dark ? 7 : 9, surface),
    recessed: mix(sink, dark ? 6 : 8, surface),
    rule: mix(ink, rulePercent, surface),
    "rule-strong": mix(ink, Math.min(rulePercent + 18, 85), surface),
    // Darker than the surface, never lighter: a shadow on the lower-right
    // that is lighter than what it sits on reads as a rendering fault, not
    // as elevation. index.css makes the same point in the graphite block.
    "shadow-edge": mix("#000000", dark ? 55 : 30, surface),

    ink,
    "ink-dim": mix(ink, 72, surface),
    "ink-sub": mix(ink, 55, surface),

    oxide: seeds.oxide,
    sage: seeds.sage,
    ochre: seeds.ochre,
    payne: seeds.payne,

    // Its own value, not the recess — see the note on --neutral-tint in
    // index.css. Aliasing them leaves neutral badges with no fill on a
    // header.
    "neutral-tint": mix(ink, dark ? 12 : 10, surface),

    // The rail is a different material, so it goes much further from the
    // page than any of the surfaces above: nearly all the way to ink under a
    // light theme, and past the page into near-black under a dark one.
    chrome: dark ? mix("#000000", 45, surface) : mix(ink, 92, surface),
    "chrome-ink": dark ? ink : surface,
    "chrome-ink-dim": dark ? mix(ink, 58, surface) : mix(surface, 62, ink),
    "chrome-rule": dark ? mix(ink, 22, surface) : mix(surface, 28, ink),
    "chrome-active": dark ? mix(ink, 10, surface) : mix(surface, 14, ink),
  };
}

export interface CustomTheme {
  seeds: ThemeSeeds;
  /**
   * The resolved token map, stored alongside the seeds that produced it.
   *
   * Redundant on purpose. The boot script in index.html has to write this
   * palette into a <style> tag *before first paint* and cannot import
   * `deriveTokens` — it runs before any module loads. The alternative is
   * reimplementing the whole derivation in inline ES5, which is a far worse
   * duplicate than a cached result. `saveCustom` is the only writer, so the
   * cache cannot drift from the seeds.
   */
  tokens: Record<TokenName, string>;
  /**
   * Tokens pinned by hand in the Advanced editor.
   *
   * Kept apart from the seeds rather than baked into a flat token map, so
   * moving a seed afterwards re-derives everything *except* what was pinned.
   * Flattening them would make one manual edit freeze the whole palette.
   */
  overrides: Partial<Record<TokenName, string>>;
}

export function resolveCustom(
  theme: Pick<CustomTheme, "seeds" | "overrides">,
): Record<TokenName, string> {
  return { ...deriveTokens(theme.seeds), ...theme.overrides };
}

/** Builds a storable theme, cache included. The only way one should be made. */
export function buildCustomTheme(
  seeds: ThemeSeeds,
  overrides: Partial<Record<TokenName, string>>,
): CustomTheme {
  return { seeds, overrides, tokens: resolveCustom({ seeds, overrides }) };
}

/** The `[data-theme="custom"]` rule body, for the pre-paint <style> tag. */
export function customThemeCss(theme: CustomTheme): string {
  // Re-derives rather than trusting the cache: this runs in the app, where
  // the seeds are authoritative and the cost is nothing.
  const tokens = resolveCustom(theme);
  const body = TOKENS.map((name) => `--${name}:${tokens[name]};`).join("");
  return `[data-theme="custom"]{color-scheme:${theme.seeds.polarity};${body}}`;
}
