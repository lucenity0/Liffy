/**
 * The two texture layers that make the page read as paper: a graph-paper
 * grid and a fractal-noise grain.
 *
 * Both are fixed at z-index 0 and the app content sits above them, because
 * the grain multiplies — over content it would tint modals and Monaco.
 * Purely decorative, so hidden from the accessibility tree, and both layers
 * drop out under `prefers-contrast: more` and in print (see index.css).
 */
export function PaperBackdrop() {
  return (
    <div aria-hidden="true">
      <div className="paper-grid" />
      <div className="paper-grain" />
    </div>
  );
}
