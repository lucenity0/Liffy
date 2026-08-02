import { useEffect, useState } from "react";

/**
 * The landing page's scroll-scrubbed figure engine.
 *
 * A tall track holds a sticky figure; how far the track has moved through the
 * viewport becomes a 0..1 progress value that drives the frame. Nothing
 * animates on a timer — scrubbing means the reader sets the pace, can stop
 * halfway, and can scroll back to watch a step again, which is the whole point
 * for a diagram explaining a pipeline.
 *
 * Reading happens in `requestAnimationFrame` on a passive listener, so
 * scrolling never touches layout — the same discipline as the original.
 */

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const stageOf = (p: number, bounds: number[]) => {
  for (let i = 0; i < bounds.length; i++) if (p < bounds[i]) return i;
  return bounds.length;
};

/**
 * Read once, at mount, rather than subscribed to.
 *
 * `matchMedia` is absent in jsdom and in some embedded browsers, and a figure
 * is decoration — it must never be able to take the answer down with it. No
 * media query means no stated preference, which is not the same as asking for
 * motion but is the right default.
 *
 * Not subscribing means toggling the OS setting mid-session does not restyle a
 * figure already on screen. That is a real limitation and a deliberate one:
 * subscribing costs a synchronous state write on every mount to stay correct
 * about a setting almost nobody changes while reading one page.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useScrollProgress(trackRef: React.RefObject<HTMLElement | null>) {
  // Reduced motion freezes on the *finished* state: the last frame is the one
  // carrying the summary, so it is the right end to stop at.
  const [reduced] = useState(prefersReducedMotion);
  const [progress, setProgress] = useState(() => (prefersReducedMotion() ? 1 : 0));

  useEffect(() => {
    if (reduced) return;
    const track = trackRef.current;
    if (!track) return;

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const rect = track.getBoundingClientRect();
        // Progress across the part of the track where the figure is actually
        // pinned: from the track's top reaching the viewport top, to its
        // bottom reaching the bottom.
        const span = rect.height - window.innerHeight;
        setProgress(span > 0 ? clamp01(-rect.top / span) : 0);
      });
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [trackRef, reduced]);

  return progress;
}
