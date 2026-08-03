import { TOKENS, type TokenName } from "@/lib/theme/derive";

/**
 * Everything about the workspace that is not colour.
 *
 * The colour half of a theme lives in derive.ts, which turns a handful of
 * seeds into the palette. This is the other half: how big the interface is,
 * how tight, how round, how loud — plus the per-component escape hatch.
 *
 * Every field here resolves to a CSS custom property and nothing else. That
 * single constraint is what makes the live preview possible: `appearanceVars`
 * produces a flat map, the app writes it into a <style> on <html>, and the
 * preview writes the *draft* of the same map onto a wrapper element as
 * inline properties. Because the semantic utilities compile to `var(--ink)`,
 * `calc(var(--spacing) * 4)` and friends, a subtree carrying different values
 * re-renders as a different workspace with no preview-aware components
 * anywhere. It is the trick `@utility chrome-surface` already plays on the
 * nav rail, applied to the whole app at once.
 *
 * Nothing here is exposed as "edit --text-sm". The page offers scale,
 * density, radius and weight; the forty values underneath move together.
 */

export const FONTS = [
  {
    id: "neon",
    label: "Monaspace Neon",
    note: "The interface face. Preloaded.",
    stack: '"Monaspace Neon", "Monaspace Fallback", ui-monospace, monospace',
  },
  {
    id: "argon",
    label: "Monaspace Argon",
    note: "Liffy's prose face. Preloaded.",
    stack: '"Monaspace Argon", "Monaspace Fallback", ui-monospace, monospace',
  },
  {
    id: "system",
    label: "System",
    note: "Whatever this OS calls its UI face.",
    stack:
      'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  {
    id: "system-mono",
    label: "System Mono",
    note: "SF Mono, Consolas, DejaVu Sans Mono.",
    stack:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  },
] as const;

export type FontId = (typeof FONTS)[number]["id"];

const FONT_STACKS: Record<FontId, string> = Object.fromEntries(
  FONTS.map((f) => [f.id, f.stack]),
) as Record<FontId, string>;

export function fontStack(id: FontId): string {
  return FONT_STACKS[id] ?? FONT_STACKS.neon;
}

/** Discrete because a font-weight slider is a control nobody can aim. */
export const HEADING_WEIGHTS = [
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 700, label: "Bold" },
] as const;

export const BODY_WEIGHTS = [
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
] as const;

export const LINE_HEIGHTS = [
  { value: 1.45, label: "Compact" },
  { value: 1.6, label: "Comfortable" },
  { value: 1.8, label: "Relaxed" },
] as const;

/**
 * ±12%, against UI Scale's ±20%.
 *
 * Both ride Tailwind's `--spacing`, so the ranges are chosen to compose:
 * Compact at 120% scale is still a larger interface than Comfortable at 90%,
 * which is what someone reaching for both of them expects.
 */
export const DENSITIES = [
  { value: 1.12, label: "Comfortable" },
  { value: 1, label: "Balanced" },
  { value: 0.88, label: "Compact" },
] as const;

export const MOTIONS = ["full", "reduced", "off"] as const;
export type Motion = (typeof MOTIONS)[number];

export const SHADOWS = ["none", "hard", "elevated"] as const;
export type Shadow = (typeof SHADOWS)[number];

export const NAVS = ["rail", "compact"] as const;
export type Nav = (typeof NAVS)[number];

/**
 * A per-component override.
 *
 * Deliberately not "any CSS": each component in the registry declares which
 * of these it accepts, and the editor only shows those. A background field
 * on a chart axis would be a control that does nothing.
 */
export interface ComponentOverride {
  background?: string;
  border?: string;
  ink?: string;
  radius?: number;
  padding?: number;
  weight?: number;
  shadow?: Shadow;
}

export interface AppearanceConfig {
  fontUi: FontId;
  fontProse: FontId;
  fontCode: FontId;
  /** 0.8 – 1.2. The one typography control that matters. */
  scale: number;
  headingWeight: number;
  bodyWeight: number;
  leading: number;
  nav: Nav;
  density: number;
  motion: Motion;
  /** px. 0–8 — the house style is near-square and the slider respects it. */
  radius: number;
  shadow: Shadow;
  components: Partial<Record<string, ComponentOverride>>;
}

/**
 * The values the app was drawn at.
 *
 * These must stay identical to the `:root` block in index.css. An install
 * that never opens Appearance renders exactly as it did before this page
 * existed, and `isDefault` below is how "Reset" knows it is finished.
 */
export const DEFAULT_APPEARANCE: AppearanceConfig = {
  fontUi: "neon",
  fontProse: "argon",
  fontCode: "argon",
  scale: 1,
  headingWeight: 500,
  bodyWeight: 400,
  leading: 1.6,
  nav: "rail",
  density: 1,
  motion: "full",
  radius: 3,
  shadow: "hard",
  components: {},
};

export const SCALE_MIN = 0.8;
export const SCALE_MAX = 1.2;
export const RADIUS_MIN = 0;
export const RADIUS_MAX = 8;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * The custom properties a config resolves to.
 *
 * Keys are CSS custom property names because both consumers want them that
 * way: the global <style> joins them into a rule body, and the preview feeds
 * them straight to `setProperty`. Nothing downstream has to know what a
 * "density" is.
 */
export function appearanceVars(
  config: AppearanceConfig,
): Record<string, string> {
  return {
    "--ui-scale": String(clamp(config.scale, SCALE_MIN, SCALE_MAX)),
    "--ui-density": String(clamp(config.density, 0.75, 1.25)),
    "--ui-radius": `${clamp(config.radius, RADIUS_MIN, RADIUS_MAX)}px`,
    "--ui-leading": String(clamp(config.leading, 1.2, 2)),
    "--ui-heading-weight": String(clamp(config.headingWeight, 100, 900)),
    "--ui-body-weight": String(clamp(config.bodyWeight, 100, 900)),
    "--ui-font-ui": fontStack(config.fontUi),
    "--ui-font-hand": fontStack(config.fontProse),
    "--ui-font-code": fontStack(config.fontCode),
  };
}

/**
 * The attributes that carry the settings a variable cannot express.
 *
 * Motion and shadow are rules, not values — "stop animating" is a `!important`
 * block and "elevate" swaps one box-shadow for another — so they ride
 * attributes on <html> that index.css keys off, the same shape `data-theme`
 * already uses. Nav is here rather than in React state so the rail's width is
 * settled before first paint.
 */
export function appearanceAttrs(
  config: AppearanceConfig,
): Record<string, string> {
  return {
    "data-motion": config.motion,
    "data-shadow": config.shadow,
    "data-nav": config.nav,
  };
}

/** `html:root` — (0,1,1), so it outranks index.css's `:root` on specificity
 *  rather than on being loaded later. Same lesson as customThemeCss. */
export function appearanceCss(config: AppearanceConfig): string {
  const body = Object.entries(appearanceVars(config))
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `html:root{${body}}${componentCss(config.components)}`;
}

/**
 * Component overrides, as scoped rules.
 *
 * Keyed on the `data-liffy` attribute the registry's components carry, so an
 * override reaches every instance of a component without any of them knowing
 * this file exists. `html:root` again, plus the attribute — comfortably above
 * anything a utility class will bring.
 */
export function componentCss(
  components: Partial<Record<string, ComponentOverride>>,
): string {
  return Object.entries(components)
    .map(([id, override]) => {
      if (!override) return "";
      const decls: string[] = [];
      if (override.background) decls.push(`background-color:${override.background}`);
      if (override.border) decls.push(`border-color:${override.border}`);
      if (override.ink) decls.push(`color:${override.ink}`);
      if (override.radius !== undefined)
        decls.push(`border-radius:${clamp(override.radius, 0, 24)}px`);
      if (override.padding !== undefined)
        decls.push(`padding:${clamp(override.padding, 0, 48)}px`);
      if (override.weight !== undefined)
        decls.push(`font-weight:${clamp(override.weight, 100, 900)}`);
      if (override.shadow)
        decls.push(
          override.shadow === "none"
            ? "box-shadow:none"
            : override.shadow === "elevated"
              ? "box-shadow:3px 3px 0 0 var(--shadow-edge)"
              : "box-shadow:1px 1px 0 0 var(--shadow-edge)",
        );
      if (!decls.length) return "";
      return `html:root [data-liffy="${cssEscape(id)}"]{${decls.join(";")};}`;
    })
    .join("");
}

/**
 * Attribute values reach a selector, so they are escaped rather than trusted.
 *
 * Component ids come from the registry today, but they also arrive from
 * imported theme files, and an imported string is somebody else's input. The
 * conservative move is to allow only what a registry id can contain; anything
 * else cannot name a component that exists anyway.
 */
function cssEscape(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

/** Whether a config is untouched, which is what lets Reset know it is done. */
export function isDefault(config: AppearanceConfig): boolean {
  return (
    JSON.stringify({ ...config, components: {} }) ===
      JSON.stringify({ ...DEFAULT_APPEARANCE, components: {} }) &&
    Object.keys(config.components).length === 0
  );
}

/**
 * Parses a config from storage or from an imported file.
 *
 * Field by field with a default behind each, rather than a shape check that
 * passes or fails the whole object: a theme exported by a later version of
 * Liffy should lose the fields this version does not know about and keep the
 * rest, not fall back to defaults entirely.
 */
export function parseAppearance(value: unknown): AppearanceConfig {
  if (!value || typeof value !== "object") return DEFAULT_APPEARANCE;
  const raw = value as Record<string, unknown>;
  const d = DEFAULT_APPEARANCE;

  const num = (key: string, fallback: number, min: number, max: number) => {
    const candidate = raw[key];
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? clamp(candidate, min, max)
      : fallback;
  };
  const oneOf = <T extends string>(
    key: string,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    const candidate = raw[key];
    return allowed.includes(candidate as T) ? (candidate as T) : fallback;
  };
  const font = (key: string, fallback: FontId): FontId =>
    oneOf(
      key,
      FONTS.map((f) => f.id),
      fallback,
    );

  return {
    fontUi: font("fontUi", d.fontUi),
    fontProse: font("fontProse", d.fontProse),
    fontCode: font("fontCode", d.fontCode),
    scale: num("scale", d.scale, SCALE_MIN, SCALE_MAX),
    headingWeight: num("headingWeight", d.headingWeight, 100, 900),
    bodyWeight: num("bodyWeight", d.bodyWeight, 100, 900),
    leading: num("leading", d.leading, 1.2, 2),
    nav: oneOf("nav", NAVS, d.nav),
    density: num("density", d.density, 0.75, 1.25),
    motion: oneOf("motion", MOTIONS, d.motion),
    radius: num("radius", d.radius, RADIUS_MIN, RADIUS_MAX),
    shadow: oneOf("shadow", SHADOWS, d.shadow),
    components: parseComponents(raw.components),
  };
}

function parseComponents(
  value: unknown,
): Partial<Record<string, ComponentOverride>> {
  if (!value || typeof value !== "object") return {};
  const out: Partial<Record<string, ComponentOverride>> = {};

  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const clean = cssEscape(id);
    if (!clean || !raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const override: ComponentOverride = {};

    // Colours are handed to the browser, which is the only real judge of a
    // colour — but they are also interpolated into a stylesheet, so anything
    // that could close a declaration and open another is dropped outright.
    for (const key of ["background", "border", "ink"] as const) {
      const candidate = o[key];
      if (typeof candidate === "string" && isSafeColor(candidate)) {
        override[key] = candidate;
      }
    }
    for (const key of ["radius", "padding", "weight"] as const) {
      const candidate = o[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        override[key] = candidate;
      }
    }
    if (SHADOWS.includes(o.shadow as Shadow)) override.shadow = o.shadow as Shadow;

    if (Object.keys(override).length) out[clean] = override;
  }
  return out;
}

/**
 * A colour, conservatively.
 *
 * The editor only ever produces `#rrggbb` from `<input type="color">`, and
 * `var(--token)` for "follow the theme". Imported files get held to the same
 * two shapes: everything here ends up inside a stylesheet this app writes,
 * and `;}` in a colour field is the one way that becomes someone else's CSS.
 */
function isSafeColor(value: string): boolean {
  return (
    /^#[0-9a-fA-F]{3,8}$/.test(value) || /^var\(--[a-zA-Z0-9-]+\)$/.test(value)
  );
}

/** Token names offered as "follow the theme" values in the component editor. */
export const THEME_COLOR_CHOICES: readonly TokenName[] = TOKENS;
