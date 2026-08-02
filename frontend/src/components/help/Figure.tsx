import { ScrollyIndexing } from "./ScrollyIndexing";
import { ScrollyReview } from "./ScrollyReview";

/**
 * Diagrams a help page can ask for by name.
 *
 * The corpus names a figure in its front matter and the drawing lives here.
 * That split is deliberate: a markdown document can never carry markup into
 * the page, which matters on an endpoint that needs no session — and it means
 * an illustration can be redrawn without touching the words it illustrates.
 *
 * Both figures are the landing page's scroll-scrubbed sequences, ported rather
 * than re-invented. Someone who watched them on the marketing site and then
 * opens Help meets the same figure instead of a second, differently-drawn
 * explanation of the same pipeline. `Scrolly` carries the engine and the
 * reduced-motion behaviour.
 */
const FIGURES: Record<string, () => React.ReactElement> = {
  "how-it-works": ScrollyReview,
  indexing: ScrollyIndexing,
};

/**
 * Renders nothing for an unknown name rather than throwing. A figure is
 * decoration on top of an answer that stands on its own — a corpus typo
 * should cost the picture, never the page.
 */
export function Figure({ name }: { name: string }) {
  const Component = FIGURES[name];
  if (!Component) return null;
  return <Component />;
}
