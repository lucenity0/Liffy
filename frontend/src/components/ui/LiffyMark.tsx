import { cn } from "@/lib/utils";

/**
 * Liffy's mark.
 *
 * The artwork as drawn — `public/liffy-logo.png`, four tones and white eyes
 * — rather than a sprite map. It was traced into one-ink rectangles first,
 * on the theory that `currentColor` themes for free, and the eyes came out
 * as holes taking whatever surface was behind them: a hollow-eyed grey
 * skull under a dark theme. Some art is not one ink, and the file is the
 * artwork.
 *
 * The same file in both themes. It was inverted for the dark side first,
 * which is a clean trick on greyscale-over-transparency — but the mark is
 * the mark, and a logo that changes colour with the page is a weaker one
 * than a logo that does not. The white eyes and pale whiskers carry it
 * against graphite; the body going quiet there is the point of a black cat.
 */
export function LiffyMark({
  className,
  title,
}: {
  className?: string;
  /**
   * Only pass this when the mark carries meaning on its own. Beside a
   * wordmark that already says the same thing it is decorative, and a
   * second announcement is noise.
   */
  title?: string;
}) {
  return (
    <img
      // BASE_URL, not a bare "/", so it survives being served from a
      // subpath — same contract as the service worker in main.tsx.
      src={`${import.meta.env.BASE_URL}liffy-logo.png`}
      width={480}
      height={407}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      decoding="async"
      className={cn("block h-auto w-auto shrink-0", className)}
    />
  );
}
