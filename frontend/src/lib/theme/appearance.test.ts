import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appearanceAttrs,
  appearanceCss,
  appearanceVars,
  componentCss,
  DEFAULT_APPEARANCE,
  isDefault,
  parseAppearance,
  RADIUS_MAX,
  SCALE_MAX,
  SCALE_MIN,
} from "./appearance";
import { COMPONENTS, pruneOverride, searchComponents } from "./components";

/* ------------------------------------------------------------------ *
 * The defaults are a promise: an install that never opens this page
 * renders exactly as it did before the page existed.
 * ------------------------------------------------------------------ */

const CSS = readFileSync(
  resolve(process.cwd(), "src/index.css"),
  "utf-8",
);

describe("the defaults", () => {
  it("match the :root block index.css declares", () => {
    // Drift here is invisible in review and loud on screen: every existing
    // install would shift the moment this shipped.
    const vars = appearanceVars(DEFAULT_APPEARANCE);
    for (const [name, value] of Object.entries(vars)) {
      if (name.startsWith("--ui-font")) continue; // stacks, compared below
      expect(CSS, `${name} in index.css`).toContain(`${name}: ${value};`);
    }
  });

  it("keeps the radius knob producing today's 2px chip and 3px sheet", () => {
    expect(appearanceVars(DEFAULT_APPEARANCE)["--ui-radius"]).toBe("3px");
    expect(CSS).toContain("--radius-chip: max(0px, calc(var(--ui-radius) - 1px))");
    expect(CSS).toContain("--radius-sheet: var(--ui-radius)");
  });

  it("is what isDefault recognises", () => {
    expect(isDefault(DEFAULT_APPEARANCE)).toBe(true);
    expect(isDefault({ ...DEFAULT_APPEARANCE, scale: 1.1 })).toBe(false);
    expect(
      isDefault({ ...DEFAULT_APPEARANCE, components: { "review-row": { padding: 4 } } }),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Specificity — the bug this page was built on top of.
 * ------------------------------------------------------------------ */

describe("appearanceCss", () => {
  it("outranks index.css's :root on specificity, not on source order", () => {
    // `html:root` is (0,1,1) against `:root`'s (0,1,0). The custom palette
    // shipped without this and lost the tie to the Paper block on every
    // fresh load, because the boot script injects above Vite's stylesheet.
    expect(appearanceCss(DEFAULT_APPEARANCE).startsWith("html:root{")).toBe(true);
  });

  it("carries every variable index.css expects to find", () => {
    const css = appearanceCss(DEFAULT_APPEARANCE);
    for (const name of Object.keys(appearanceVars(DEFAULT_APPEARANCE))) {
      expect(css).toContain(`${name}:`);
    }
  });
});

describe("appearanceAttrs", () => {
  it("names the three attributes index.css keys its rules off", () => {
    const attrs = appearanceAttrs({
      ...DEFAULT_APPEARANCE,
      motion: "off",
      shadow: "none",
      nav: "compact",
    });
    expect(attrs).toEqual({
      "data-motion": "off",
      "data-shadow": "none",
      "data-nav": "compact",
    });
    for (const [name, value] of Object.entries(attrs)) {
      expect(CSS, `${name}="${value}" rule`).toContain(`html[${name}="${value}"]`);
    }
  });

  /**
   * The finding from Liffy's second review: the OS backstop selects on bare
   * `*` at (0,0,0), and `html[data-motion="reduced"] *` is (0,1,1) — both
   * `!important`, so specificity decided and "reduced" could *weaken* an OS
   * request for less motion instead of only ever adding to it, which the
   * comment above the rule claims is impossible. jsdom does not evaluate
   * `@media` against real media features, so this cannot be proven through a
   * rendered cascade — it asserts the shape that makes the invariant true
   * instead: the "reduced" rule sits inside a `no-preference` guard, so it
   * can never fire when the OS block already applies, and "off" needs no
   * such guard because it is already identical to the OS block.
   */
  it("guards data-motion=\"reduced\" so it cannot outrank the OS's own request", () => {
    const guarded = /@media \(prefers-reduced-motion:\s*no-preference\)\s*\{[^}]*html\[data-motion="reduced"\]/s;
    expect(CSS).toMatch(guarded);

    // "off" is deliberately unguarded: it matches the media query's own
    // declarations, so agreeing with it is never a weakening.
    const offIndex = CSS.indexOf('html[data-motion="off"]');
    const precedingMedia = CSS.lastIndexOf("@media", offIndex);
    const precedingClose = CSS.lastIndexOf("}", offIndex);
    expect(precedingClose).toBeGreaterThan(precedingMedia);
  });
});

/* ------------------------------------------------------------------ *
 * Parsing — storage, and imported files, which are somebody else's input.
 * ------------------------------------------------------------------ */

describe("parseAppearance", () => {
  it("falls back to the defaults for anything unusable", () => {
    for (const input of [null, undefined, 42, "nope", []]) {
      expect(parseAppearance(input)).toEqual(DEFAULT_APPEARANCE);
    }
  });

  it("keeps the fields it knows and defaults the rest", () => {
    // A theme written by a later Liffy should lose the fields this version
    // has never heard of and keep everything else, not reset wholesale.
    const parsed = parseAppearance({
      scale: 1.1,
      nav: "compact",
      quantumRadius: "yes",
    });
    expect(parsed.scale).toBe(1.1);
    expect(parsed.nav).toBe("compact");
    expect(parsed.leading).toBe(DEFAULT_APPEARANCE.leading);
  });

  it("clamps numbers into range rather than trusting them", () => {
    expect(parseAppearance({ scale: 40 }).scale).toBe(SCALE_MAX);
    expect(parseAppearance({ scale: -3 }).scale).toBe(SCALE_MIN);
    expect(parseAppearance({ radius: 900 }).radius).toBe(RADIUS_MAX);
    expect(parseAppearance({ scale: Number.NaN }).scale).toBe(
      DEFAULT_APPEARANCE.scale,
    );
  });

  it("rejects an enum value it does not recognise", () => {
    expect(parseAppearance({ motion: "interpretive-dance" }).motion).toBe("full");
    expect(parseAppearance({ fontUi: "comic-sans" }).fontUi).toBe("neon");
  });
});

/* ------------------------------------------------------------------ *
 * Component overrides land in a stylesheet, so an imported colour is
 * the one field that could become somebody else's CSS.
 * ------------------------------------------------------------------ */

describe("component overrides", () => {
  it("emits a rule that selects on the data-liffy attribute", () => {
    const css = componentCss({ "review-header": { background: "#123456" } });
    expect(css).toBe(
      'html:root [data-liffy="review-header"]{background-color:#123456;}',
    );
  });

  it("drops a colour that could close the declaration and open another", () => {
    const parsed = parseAppearance({
      components: {
        "review-row": { background: "#fff;} html{display:none} .x{a:b" },
      },
    });
    expect(parsed.components["review-row"]).toBeUndefined();
    expect(componentCss(parsed.components)).not.toContain("display:none");
  });

  /**
   * `parseAppearance`/`parseComponents` cover storage and imported files, but
   * the live editor's free-text hex field writes straight to `update({
   * components })` → `applyAppearance` → `componentCss`, never through the
   * parser. This calls `componentCss` directly with the unsafe value — the
   * shape the editor would actually produce — to prove the emission layer
   * itself refuses it rather than relying on every caller having validated
   * first.
   */
  it("sanitizes a colour at the point of emission, not only on the way in from storage", () => {
    const css = componentCss({
      "review-header": {
        background: "#fff;} html{display:none} .x{color:red",
      },
    });
    expect(css).not.toContain("display:none");
    // No safe declaration survives, so the rule is omitted entirely rather
    // than emitted empty.
    expect(css).toBe("");
  });

  it("still emits the declarations that are safe when only one colour is not", () => {
    const css = componentCss({
      "review-header": {
        background: "#123456",
        border: "#fff;} html{display:none}",
      },
    });
    expect(css).toContain("background-color:#123456");
    expect(css).not.toContain("display:none");
    expect(css).not.toContain("border-color");
  });

  it("strips anything that is not a registry id out of the selector", () => {
    const parsed = parseAppearance({
      components: { 'x"]{color:red}[data-liffy="y': { radius: 4 } },
    });
    const css = componentCss(parsed.components);
    expect(css).not.toContain("color:red");
    expect(css.match(/\[data-liffy="/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("accepts a plain hex and a theme token reference", () => {
    const parsed = parseAppearance({
      components: {
        "metric-card": { background: "#0b0b0b", ink: "var(--ink-dim)" },
      },
    });
    expect(parsed.components["metric-card"]).toEqual({
      background: "#0b0b0b",
      ink: "var(--ink-dim)",
    });
  });

  it("prunes knobs a component does not accept", () => {
    // `review-row` has no shadow or radius: an imported theme carrying them
    // must not produce a control the editor never showed.
    const pruned = pruneOverride("review-row", {
      padding: 6,
      shadow: "elevated",
      radius: 12,
    });
    expect(pruned).toEqual({ padding: 6 });
  });

  it("prunes an unknown component to nothing", () => {
    expect(pruneOverride("not-a-component", { padding: 6 })).toEqual({});
  });

  /**
   * `pruneOverride` runs in the editor, on the way out of a control — but
   * the import path (parseSaved → parseAppearance → applySaved → replace →
   * componentCss) never reaches that call. Parsing has to prune too, or a
   * theme file is the one way to get a declaration no control can undo.
   */
  it("prunes on the way in, not only in the editor", () => {
    const parsed = parseAppearance({
      components: { "review-row": { padding: 6, shadow: "elevated", radius: 12 } },
    });
    expect(parsed.components["review-row"]).toEqual({ padding: 6 });

    const css = componentCss(parsed.components);
    expect(css).toContain("padding");
    expect(css).not.toContain("box-shadow");
    expect(css).not.toContain("border-radius");
  });

  it("drops an override for a component the registry does not name", () => {
    const parsed = parseAppearance({
      components: { "not-a-component": { padding: 6 } },
    });
    expect(parsed.components).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * The registry's promise: every entry names something that exists.
 * ------------------------------------------------------------------ */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

const SOURCES = sourceFiles(resolve(process.cwd(), "src"))
  .map((path) => readFileSync(path, "utf-8"))
  .join("\n");

describe("the component registry", () => {
  it.each(COMPONENTS.map((spec) => spec.id))(
    "%s is carried by a real element in the app",
    (id) => {
      // A registry entry with nothing wearing its attribute is a dead search
      // result: it appears in ⌘K, highlights nothing, and its editor writes
      // a rule that matches no element.
      expect(SOURCES).toContain(`data-liffy="${id}"`);
    },
  );

  it("is also fully represented in the preview", () => {
    const preview = readFileSync(
      resolve(process.cwd(), "src/components/settings/appearance/LivePreview.tsx"),
      "utf-8",
    );
    for (const spec of COMPONENTS) {
      expect(preview, `${spec.id} in the preview`).toContain(
        `data-liffy="${spec.id}"`,
      );
    }
  });

  it("only offers knobs the override writer can emit", () => {
    for (const spec of COMPONENTS) {
      expect(spec.knobs.length).toBeGreaterThan(0);
      const css = componentCss({
        [spec.id]: {
          background: "#111111",
          border: "#222222",
          ink: "#333333",
          radius: 5,
          padding: 7,
          weight: 700,
          shadow: "elevated",
        },
      });
      expect(css).toContain(`[data-liffy="${spec.id}"]`);
    }
  });
});

describe("searchComponents", () => {
  it("returns everything for an empty query, so ⌘K browses too", () => {
    expect(searchComponents("")).toHaveLength(COMPONENTS.length);
    expect(searchComponents("   ")).toHaveLength(COMPONENTS.length);
  });

  it("ranks the closer label first rather than returning registry order", () => {
    const hits = searchComponents("metric");
    expect(hits[0].id).toBe("metric-card");
  });

  it("finds components by what someone would actually call them", () => {
    expect(searchComponents("pr")[0].id).toBe("review-header");
    expect(searchComponents("pill")[0].id).toBe("finding-badge");
    expect(searchComponents("graph")[0].id).toBe("analytics-chart");
    expect(searchComponents("nav")[0].id).toBe("sidebar-item");
  });

  it("returns nothing for a miss instead of everything", () => {
    expect(searchComponents("zzzzz")).toHaveLength(0);
  });
});
