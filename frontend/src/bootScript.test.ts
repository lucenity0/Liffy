import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePrefs, resolveTheme, THEME_KEY } from "@/hooks/useTheme";
import { DEFAULT_THEME, THEMES, themeSpec, type ThemeId } from "@/lib/themes";

/**
 * The boot script in index.html, tested against the module it duplicates.
 *
 * It cannot import anything — it runs before the first paint and before any
 * module loads, which is the entire reason it exists — so it restates the
 * theme table and the storage format in hand-written ES5. Two implementations
 * of one contract, kept in step by a comment asking nicely.
 *
 * So rather than restating the expected behaviour a third time, this extracts
 * the real script out of the real index.html, runs it, and asserts it agrees
 * with parsePrefs + resolveTheme. Drift between the two becomes a failing
 * test instead of a flash of the wrong palette on someone's screen.
 */

// Vitest's root is the frontend package, where index.html sits.
const html = readFileSync(resolve(process.cwd(), "index.html"), "utf-8");

/** The first inline <script> in <head> — the theme boot, by construction. */
function extractBootScript(): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("no inline <script> found in index.html");
  return match[1];
}

const boot = extractBootScript();

function runBoot() {
  new Function(boot)();
}

function setSystemDark(dark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: dark && query.includes("dark"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

let meta: HTMLMetaElement;

beforeEach(() => {
  localStorage.clear();
  const root = document.documentElement;
  delete root.dataset.theme;
  root.classList.remove("light", "dark");

  meta = document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  document.head.appendChild(meta);

  setSystemDark(false);
});

afterEach(() => meta.remove());

describe("the index.html boot script", () => {
  it("is actually present — the anti-flash guarantee rests on it", () => {
    expect(boot).toContain(THEME_KEY);
    expect(boot).toContain("data-theme");
  });

  /**
   * The cross-check that matters. Every case runs the real script and the
   * real module against the same input and demands the same answer.
   */
  const cases: { name: string; stored: string | null; systemDark: boolean }[] = [
    { name: "nothing stored", stored: null, systemDark: false },
    { name: "nothing stored, OS dark", stored: null, systemDark: true },
    { name: "legacy bare paper", stored: "paper", systemDark: true },
    { name: "legacy bare graphite", stored: "graphite", systemDark: false },
    { name: "garbage", stored: "not-json{", systemDark: false },
    { name: "unknown theme name", stored: '{"theme":"chartreuse"}', systemDark: false },
    {
      name: "pinned theme",
      stored: JSON.stringify({ mode: "fixed", theme: "paper" }),
      systemDark: true,
    },
    {
      name: "system mode, OS light",
      stored: JSON.stringify({ mode: "system", light: "paper", dark: "graphite" }),
      systemDark: false,
    },
    {
      name: "system mode, OS dark",
      stored: JSON.stringify({ mode: "system", light: "paper", dark: "graphite" }),
      systemDark: true,
    },
  ];

  it.each(cases)("agrees with useTheme for $name", ({ stored, systemDark }) => {
    if (stored !== null) localStorage.setItem(THEME_KEY, stored);
    setSystemDark(systemDark);

    runBoot();

    const expected = resolveTheme(parsePrefs(stored), systemDark);
    expect(document.documentElement.dataset.theme).toBe(expected);
  });

  it.each(THEMES.map((s) => s.id))(
    "sets the attribute, the polarity class and the meta colour for %s",
    (id: ThemeId) => {
      localStorage.setItem(THEME_KEY, JSON.stringify({ mode: "fixed", theme: id }));

      runBoot();

      const spec = themeSpec(id);
      const root = document.documentElement;
      expect(root.dataset.theme).toBe(id);
      expect(root.classList.contains(spec.polarity)).toBe(true);
      expect(meta.getAttribute("content")).toBe(spec.color);
    },
  );

  it("knows every theme in the registry", () => {
    // The script carries its own copy of the table. A theme added to
    // lib/themes.ts but not here would boot as the default and then snap —
    // exactly the flash the script exists to prevent.
    for (const spec of THEMES) {
      expect(boot).toContain(spec.id);
      expect(boot).toContain(spec.color);
    }
  });

  it("falls back to the default when localStorage throws outright", () => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("storage is partitioned");
    };

    try {
      runBoot();
      expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME);
    } finally {
      Storage.prototype.getItem = getItem;
    }
  });
});
