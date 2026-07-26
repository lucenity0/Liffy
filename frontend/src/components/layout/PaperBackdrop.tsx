/**
 * The two texture layers that make the page read as paper: a fractal-noise
 * grain and a faint ruled wash.
 *
 * Both are fixed at z-index 0 and the app content sits above them, because
 * the grain multiplies — over content it would tint modals and Monaco.
 * Purely decorative, so hidden from the accessibility tree, and both layers
 * drop out under `prefers-contrast: more` and in print (see index.css).
 */
export function PaperBackdrop() {
  return (
    <div aria-hidden="true">
      <div className="paper-ruled" />
      <div className="paper-grain" />
    </div>
  );
}
