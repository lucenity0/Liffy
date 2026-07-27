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

export const PAPER_THEME = "liffy-paper";
export const GRAPHITE_THEME = "liffy-graphite";

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
 * Both themes, built from the same CSS variables.
 *
 * Monaco does not read custom properties — it wants literal hex — so the
 * palette is resolved through the browser rather than restated here.
 *
 * `scope` is always passed explicitly, never left to the ambient page. Both
 * themes are defined in one pass on whichever mode the app booted in, so
 * reading ambient values would build the *other* theme out of the current
 * palette — a graphite boot would give "paper" a graphite background.
 */
function defineTheme(name: string, scope: "light" | "dark") {
  const dark = scope === "dark";
  const ink = resolveColor("--ink", dark ? "#e6e1d6" : "#2b2925", scope);
  const inkDim = resolveColor("--ink-dim", dark ? "#9c9280" : "#6b6459", scope);
  const inkSub = resolveColor("--ink-sub", dark ? "#786f60" : "#8e8678", scope);
  const rule = resolveColor("--rule", dark ? "#423d36" : "#ded8cb", scope);
  const surface = resolveColor("--card", dark ? "#28251f" : "#faf8f3", scope);
  const sage = resolveColor("--sage", dark ? "#7ba171" : "#4a6b4a", scope);
  const payne = resolveColor("--payne", dark ? "#84a5c2" : "#3f5a73", scope);
  const oxide = resolveColor("--oxide", dark ? "#dd8462" : "#9a3f2b", scope);

  monaco.editor.defineTheme(name, {
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

let configured = false;

/**
 * Idempotent: React 19 StrictMode mounts twice in development, and redefining
 * the same two themes on every mount is wasted work.
 *
 * Still a `beforeMount` hook rather than module scope, unlike the loader
 * config above: themes only need to exist by the time the editor is created,
 * and resolving the palette on first mount rather than on chunk load keeps it
 * behind the same lazy boundary as everything else here.
 */
export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  // Both up front, in the one pass. Defining graphite lazily on first flip
  // would mean resolving the palette while the editor is already mounted,
  // for no saving worth the extra state.
  defineTheme(PAPER_THEME, "light");
  defineTheme(GRAPHITE_THEME, "dark");

  return monaco;
}
