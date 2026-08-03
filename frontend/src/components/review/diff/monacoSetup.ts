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
import { resolveColor } from "@/lib/colors";
import { polarityOf, type ThemeId } from "@/lib/themes";

/** Monaco's name for a Liffy theme. Namespaced so it cannot collide. */
export function monacoThemeName(theme: ThemeId): string {
  return `liffy-${theme}`;
}

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

/**
 * Module scope, not inside setupMonaco — this has to happen before
 * @monaco-editor/react resolves an instance, and `beforeMount` is already
 * too late: the wrapper loads Monaco *first*, then calls the hook. Configured
 * from there, the CDN copy had already won, so the editor on screen was a
 * second Monaco that had never heard of the themes defined below — which is
 * why it rendered in the stock `vs` white, and why the local-package wiring
 * this comment block promises was not actually happening.
 *
 * Safe at import time: the only route to this module is the React.lazy chunk
 * behind MonacoDiff, which is fetched long after the stylesheet is applied.
 */
window.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

loader.config({ monaco });

/**
 * One editor theme, built from that theme's CSS variables.
 *
 * Monaco does not read custom properties — it wants literal hex — so the
 * palette is resolved through the browser rather than restated here.
 *
 * The theme is always passed to resolveColor explicitly, never left to the
 * ambient page: a theme may be defined while the document is wearing a
 * different one, and reading ambient values would build it out of the wrong
 * palette.
 *
 * The fallbacks are the only place the palette is duplicated in TS. They
 * matter solely if the probe fails outright (no layout, no document), so they
 * approximate by polarity rather than tracking every theme's exact values —
 * a per-theme table here would be five more copies to drift.
 */
function defineTheme(theme: ThemeId) {
  const dark = polarityOf(theme) === "dark";
  const at = (name: string, light: string, darkValue: string) =>
    resolveColor(name, dark ? darkValue : light, theme);

  const ink = at("--ink", "#2b2925", "#e6e1d6");
  const inkDim = at("--ink-dim", "#524b3e", "#b2a898");
  const inkSub = at("--ink-sub", "#696154", "#958c7c");
  const rule = at("--rule", "#c5bca9", "#423d36");
  const surface = at("--card", "#fbf9f5", "#28251f");
  const sage = at("--sage", "#456646", "#7ba171");
  const payne = at("--payne", "#3b5670", "#84a5c2");
  const oxide = at("--oxide", "#9a3f2b", "#dd8462");

  monaco.editor.defineTheme(monacoThemeName(theme), {
    // `vs-dark` matters beyond colour: it is what flips Monaco's own
    // widgets — find box, hover, context menu — which the `colors` map below
    // does not enumerate.
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "", foreground: ink.slice(1) },
      { token: "comment", foreground: inkSub.slice(1), fontStyle: "italic" },
      { token: "string", foreground: sage.slice(1) },
      { token: "keyword", foreground: payne.slice(1) },
      { token: "number", foreground: oxide.slice(1) },
      { token: "type", foreground: payne.slice(1) },
      { token: "delimiter", foreground: inkDim.slice(1) },
    ],
    colors: {
      "editor.background": surface,
      "editor.foreground": ink,
      "editorLineNumber.foreground": inkSub,
      "editorLineNumber.activeForeground": inkDim,
      "editorGutter.background": surface,
      "editor.lineHighlightBackground": "#00000000",
      "editor.lineHighlightBorder": "#00000000",
      "editorIndentGuide.background1": rule,
      "editorOverviewRuler.border": "#00000000",
      "scrollbarSlider.background": `${rule}80`,
      "scrollbarSlider.hoverBackground": rule,
      "scrollbarSlider.activeBackground": rule,
    },
  });
}

const defined = new Set<ThemeId>();

/**
 * Defines a theme with Monaco if it has not been defined already.
 *
 * A Set rather than the old single `configured` flag, and lazy rather than
 * all-up-front: with two themes it was reasonable to build both on first
 * mount, but resolving every palette in the ladder to serve the one the
 * reader is actually looking at is work for its own sake. Each costs a
 * handful of hidden-probe reads, paid the first time that theme is shown.
 *
 * Idempotent because React 19 StrictMode mounts twice in development.
 */
export function ensureTheme(theme: ThemeId): string {
  if (!defined.has(theme)) {
    defineTheme(theme);
    defined.add(theme);
  }
  return monacoThemeName(theme);
}

/**
 * A `beforeMount` hook rather than module scope, unlike the loader config
 * above: themes only need to exist by the time the editor is created, and
 * resolving the palette on first mount rather than on chunk load keeps it
 * behind the same lazy boundary as everything else here.
 */
export function setupMonaco(): typeof monaco {
  return monaco;
}
