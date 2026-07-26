import * as monaco from "monaco-editor/editor/editor.api";
// Monarch grammars for ~60 languages, all of which tokenize on the main
// thread. The heavyweight contributions (typescript, json, css, html) are
// deliberately not imported: they exist for diagnostics and completions in an
// editor you type into, and they are what drags in the language *workers*.
// This viewer is read-only, so highlighting is all it needs.
import "monaco-editor/basic-languages/monaco.contribution";
import { loader } from "@monaco-editor/react";
// ?worker is Vite's own worker import — Monaco's default loader would fetch
// this from jsDelivr, which is not an option for a self-hosted tool.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

export const PAPER_THEME = "liffy-paper";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

/**
 * Reads a CSS custom property as a hex colour.
 *
 * Monaco's theme API only takes hex strings, and half the palette is defined
 * with `color-mix()`, so the declared value is unusable as-is. Painting it on
 * a throwaway element and reading it back lets the browser resolve it, which
 * keeps index.css the single source of truth instead of duplicating the
 * palette here where it would quietly drift.
 */
function resolveColor(variable: string, fallback: string): string {
  try {
    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    probe.style.display = "none";
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();

    const rgb = computed.match(/\d+(\.\d+)?/g);
    if (!rgb || rgb.length < 3) return fallback;

    return `#${rgb
      .slice(0, 3)
      .map((part) => Math.round(Number(part)).toString(16).padStart(2, "0"))
      .join("")}`;
  } catch {
    return fallback;
  }
}

let configured = false;

/**
 * Idempotent: React 19 StrictMode mounts twice in development, and defining
 * the same theme or reassigning the loader on every mount is wasted work.
 */
export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  window.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };

  const paper = resolveColor("--card", "#faf8f3");
  const ink = resolveColor("--ink", "#2b2925");
  const inkDim = resolveColor("--ink-dim", "#6b6459");
  const inkSub = resolveColor("--ink-sub", "#8e8678");
  const rule = resolveColor("--rule", "#ded8cb");

  monaco.editor.defineTheme(PAPER_THEME, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "", foreground: ink.slice(1) },
      { token: "comment", foreground: inkSub.slice(1), fontStyle: "italic" },
      { token: "string", foreground: resolveColor("--sage", "#4a6b4a").slice(1) },
      { token: "keyword", foreground: resolveColor("--payne", "#3f5a73").slice(1) },
      { token: "number", foreground: resolveColor("--oxide", "#9a3f2b").slice(1) },
      { token: "type", foreground: resolveColor("--payne", "#3f5a73").slice(1) },
      { token: "delimiter", foreground: inkDim.slice(1) },
    ],
    colors: {
      "editor.background": paper,
      "editor.foreground": ink,
      "editorLineNumber.foreground": inkSub,
      "editorLineNumber.activeForeground": inkDim,
      "editorGutter.background": paper,
      "editor.lineHighlightBackground": "#00000000",
      "editor.lineHighlightBorder": "#00000000",
      "editorIndentGuide.background1": rule,
      "editorOverviewRuler.border": "#00000000",
      "scrollbarSlider.background": `${rule}80`,
      "scrollbarSlider.hoverBackground": rule,
      "scrollbarSlider.activeBackground": rule,
    },
  });

  // Point @monaco-editor/react at the local package. Its default is a CDN.
  loader.config({ monaco });

  return monaco;
}
