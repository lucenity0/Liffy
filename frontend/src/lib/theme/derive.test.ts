import { describe, expect, it } from "vitest";
import {
  buildCustomTheme,
  customThemeCss,
  DEFAULT_SEEDS,
  deriveTokens,
  resolveCustom,
  TOKENS,
} from "./derive";

describe("deriveTokens", () => {
  it("produces every token a theme block sets", () => {
    const tokens = deriveTokens(DEFAULT_SEEDS.dark);
    // A missing token falls through to :root's paper value at runtime, which
    // is a half-themed page rather than an error — so the set is asserted.
    for (const name of TOKENS) {
      expect(tokens[name], name).toBeTruthy();
    }
  });

  it("emits color-mix expressions, not resolved hex", () => {
    // The browser resolves these, exactly as index.css does — which is what
    // makes a custom theme the same shape as a built-in one.
    expect(deriveTokens(DEFAULT_SEEDS.dark).card).toContain("color-mix(in oklab");
  });

  it("passes the seeds through untouched", () => {
    const tokens = deriveTokens(DEFAULT_SEEDS.light);
    expect(tokens.paper).toBe(DEFAULT_SEEDS.light.surface);
    expect(tokens.ink).toBe(DEFAULT_SEEDS.light.ink);
    expect(tokens.oxide).toBe(DEFAULT_SEEDS.light.oxide);
  });

  it("never aliases the neutral tint to the recess", () => {
    // The bug this whole exercise started from: aliased, a neutral badge on a
    // Sheet.Header has no fill at all.
    const tokens = deriveTokens(DEFAULT_SEEDS.dark);
    expect(tokens["neutral-tint"]).not.toBe(tokens.recessed);
  });

  it("keeps the chrome plane distinct from all three page surfaces", () => {
    const tokens = deriveTokens(DEFAULT_SEEDS.light);
    expect(tokens.chrome).not.toBe(tokens.paper);
    expect(tokens.chrome).not.toBe(tokens.card);
    expect(tokens.chrome).not.toBe(tokens.recessed);
  });

  it("moves the rule with its slider", () => {
    const soft = deriveTokens({ ...DEFAULT_SEEDS.dark, ruleStrength: 0 });
    const hard = deriveTokens({ ...DEFAULT_SEEDS.dark, ruleStrength: 100 });
    expect(soft.rule).not.toBe(hard.rule);
    // Floored well above zero: below ~15% a hairline stops being visible,
    // which is exactly the failure the retune existed to fix.
    expect(soft.rule).toContain("15%");
  });
});

describe("overrides", () => {
  it("pins one token without freezing the rest", () => {
    const seeds = DEFAULT_SEEDS.dark;
    const pinned = resolveCustom({ seeds, overrides: { rule: "#ff0000" } });
    expect(pinned.rule).toBe("#ff0000");
    // Everything else still follows the seeds — the reason overrides are
    // stored apart rather than flattened into a token map.
    expect(pinned.card).toBe(deriveTokens(seeds).card);
  });

  it("re-derives an unpinned token when a seed moves", () => {
    const overrides = { rule: "#ff0000" };
    const a = resolveCustom({ seeds: DEFAULT_SEEDS.dark, overrides });
    const b = resolveCustom({
      seeds: { ...DEFAULT_SEEDS.dark, surface: "#000000" },
      overrides,
    });
    expect(a.card).not.toBe(b.card);
    expect(b.rule).toBe("#ff0000");
  });
});

describe("buildCustomTheme", () => {
  /**
   * The cache exists for the boot script, which cannot import deriveTokens —
   * it runs before any module loads. If it ever disagreed with the seeds the
   * page would paint one palette and then swap to another.
   */
  it("caches a token map that agrees with the seeds", () => {
    const theme = buildCustomTheme(DEFAULT_SEEDS.light, { ink: "#123456" });
    expect(theme.tokens).toEqual(resolveCustom(theme));
    expect(theme.tokens.ink).toBe("#123456");
  });
});

describe("customThemeCss", () => {
  it("scopes to html[data-theme=custom] and declares its own color-scheme", () => {
    const css = customThemeCss(buildCustomTheme(DEFAULT_SEEDS.light, {}));
    // `html` is not cosmetic. Without it this rule ties with :root at (0,1,0)
    // and loses on source order to the stylesheet Vite injects after the boot
    // script — which rendered every freshly loaded custom theme as Paper.
    expect(css.startsWith('html[data-theme="custom"]{')).toBe(true);
    // Native controls and scrollbars do not read custom properties, so the
    // palette has to say which way round it is.
    expect(css).toContain("color-scheme:light");
    for (const name of TOKENS) expect(css).toContain(`--${name}:`);
  });
});
