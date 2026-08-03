import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, parseAppearance } from "./appearance";
import { DEFAULT_SEEDS } from "./derive";
import {
  customFromSaved,
  deleteTheme,
  duplicateTheme,
  exportTheme,
  importTheme,
  listThemes,
  parseLibrary,
  renameTheme,
  saveTheme,
  THEME_FILE_VERSION,
  type SavedTheme,
} from "./library";

/**
 * The library exists because the page it replaces had one custom slot, so
 * building a second theme destroyed the first. These are the guarantees that
 * makes: a save keeps both halves of a look, a round trip through a file
 * changes nothing, and a file from somewhere else cannot do anything a file
 * from here could not.
 */

const SEEDS = { ...DEFAULT_SEEDS.dark, surface: "#101014" };

function save(name: string, at = 1000): SavedTheme[] {
  return saveTheme(
    {
      name,
      base: "custom",
      seeds: SEEDS,
      overrides: { ink: "#eeeeee" },
      appearance: { ...DEFAULT_APPEARANCE, scale: 1.1, nav: "compact" },
    },
    at,
  );
}

beforeEach(() => localStorage.clear());

describe("saving", () => {
  it("keeps the palette and the workspace shape together", () => {
    const [theme] = save("Midnight");
    expect(theme.seeds?.surface).toBe("#101014");
    expect(theme.appearance.scale).toBe(1.1);
    expect(theme.appearance.nav).toBe("compact");
  });

  it("replaces a same-named theme rather than accumulating copies", () => {
    save("Midnight", 1000);
    const themes = save("Midnight", 2000);
    expect(themes).toHaveLength(1);
    expect(themes[0].savedAt).toBe(2000);
  });

  it("matches names case-insensitively — two Midnights is a mistake", () => {
    save("Midnight");
    expect(save("midnight")).toHaveLength(1);
  });

  it("survives a nameless save rather than storing a blank row", () => {
    const [theme] = saveTheme(
      { name: "   ", base: "paper", seeds: null, overrides: {}, appearance: DEFAULT_APPEARANCE },
      1,
    );
    expect(theme.name).toBe("Untitled");
  });

  it("orders newest first", () => {
    save("Older", 1000);
    save("Newer", 2000);
    expect(listThemes().map((theme) => theme.name)).toEqual(["Newer", "Older"]);
  });
});

describe("rename, duplicate and delete", () => {
  it("renames in place, keeping the id", () => {
    const [before] = save("Midnight");
    const [after] = renameTheme(before.id, "Aurora");
    expect(after.id).toBe(before.id);
    expect(after.name).toBe("Aurora");
  });

  it("ignores a rename to nothing", () => {
    const [theme] = save("Midnight");
    expect(renameTheme(theme.id, "   ")[0].name).toBe("Midnight");
  });

  it("duplicates to a new id under a free name", () => {
    const [theme] = save("Midnight");
    const themes = duplicateTheme(theme.id, 2000);
    expect(themes).toHaveLength(2);
    const copy = themes.find((candidate) => candidate.id !== theme.id)!;
    expect(copy.name).toBe("Midnight copy");
    expect(copy.seeds).toEqual(theme.seeds);
  });

  it("does not collide when duplicating twice", () => {
    const [theme] = save("Midnight");
    duplicateTheme(theme.id, 2000);
    const themes = duplicateTheme(theme.id, 3000);
    const names = themes.map((candidate) => candidate.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("deletes only the one asked for", () => {
    const [first] = save("A", 1000);
    save("B", 2000);
    expect(deleteTheme(first.id).map((theme) => theme.name)).toEqual(["B"]);
  });
});

describe("export and import", () => {
  it("round-trips a theme without changing it", () => {
    const [theme] = save("Midnight");
    const result = importTheme(exportTheme(theme));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.theme.name).toBe("Midnight");
    expect(result.theme.seeds).toEqual(theme.seeds);
    expect(result.theme.overrides).toEqual(theme.overrides);
    expect(result.theme.appearance).toEqual(theme.appearance);
  });

  it("writes a file a person can read and edit", () => {
    const [theme] = save("Midnight");
    const text = exportTheme(theme);
    expect(text).toContain('"name": "Midnight"');
    expect(text).toContain(`"liffy": ${THEME_FILE_VERSION}`);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("says why, rather than throwing, for anything it cannot read", () => {
    expect(importTheme("not json")).toMatchObject({ ok: false });
    expect(importTheme("[]")).toMatchObject({ ok: false });
    expect(importTheme('{"name":"x"}')).toMatchObject({ ok: false });
    // Every failure has to put something on screen, so none of them may be
    // an empty string.
    for (const input of ["not json", "[]", '{"name":"x"}']) {
      const result = importTheme(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("refuses a file from a newer Liffy instead of guessing", () => {
    const result = importTheme(
      JSON.stringify({ liffy: THEME_FILE_VERSION + 1, name: "Future" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("newer Liffy");
  });

  it("holds an imported file to the same limits as the editor", () => {
    const result = importTheme(
      JSON.stringify({
        liffy: THEME_FILE_VERSION,
        name: "Hostile",
        base: "custom",
        seeds: { ...SEEDS, ruleStrength: 9000 },
        overrides: { ink: "red;} html{display:none" },
        appearance: { scale: 99 },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.theme.seeds?.ruleStrength).toBe(100);
    expect(result.theme.overrides.ink).toBeUndefined();
    expect(result.theme.appearance.scale).toBe(1.2);
  });

  it("takes a name from a file that has none", () => {
    const result = importTheme(JSON.stringify({ liffy: THEME_FILE_VERSION }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.theme.name).toBe("Imported");
  });
});

describe("parseLibrary", () => {
  it("returns nothing for an empty or broken store", () => {
    expect(parseLibrary(null)).toEqual([]);
    expect(parseLibrary("{")).toEqual([]);
    expect(parseLibrary('{"not":"an array"}')).toEqual([]);
  });

  it("drops the unreadable entries and keeps the rest", () => {
    const themes = parseLibrary(
      JSON.stringify([
        { name: "Good", base: "paper", appearance: {} },
        { base: "paper" },
        null,
        "nope",
      ]),
    );
    expect(themes.map((theme) => theme.name)).toEqual(["Good"]);
    expect(themes[0].appearance).toEqual(parseAppearance({}));
  });
});

describe("customFromSaved", () => {
  it("rebuilds a usable custom theme, cache included", () => {
    const [theme] = save("Midnight");
    const custom = customFromSaved(theme);
    expect(custom).not.toBeNull();
    expect(custom?.tokens.paper).toBe("#101014");
    // The pinned ink wins over the derived one, as it does in the editor.
    expect(custom?.tokens.ink).toBe("#eeeeee");
  });

  it("returns null for a preset-based theme, which has no palette of its own", () => {
    const [theme] = saveTheme(
      { name: "Just Paper", base: "paper", seeds: null, overrides: {}, appearance: DEFAULT_APPEARANCE },
      1,
    );
    expect(customFromSaved(theme)).toBeNull();
  });
});
