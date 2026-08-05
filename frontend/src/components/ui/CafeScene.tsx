import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  CAT_BOX,
  CAT_H,
  CAT_W,
  SCENE_H,
  SCENE_W,
  mountCafeScene,
} from "@/lib/cafeScene";

/**
 * Liffy's illustration: a cat asleep on a café windowsill.
 *
 * Two layers on one pixel grid. The room is painted on the canvas by
 * `mountCafeScene` and themes itself off the --scene-* tokens; the cat is a
 * 40-frame gif laid over it at the same scale. Splitting them that way is
 * what lets the room follow the theme ladder — and turn into a night through
 * the window under a dark one — while the cat stays the drawn artwork it is.
 *
 * The frame's aspect-ratio is the canvas's, not a round number, because the
 * two layers only line up if the whole thing scales as one drawing.
 */
export function CafeScene({ className }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvas.current) return;
    return mountCafeScene(canvas.current);
  }, []);

  return (
    // One label on the frame with both layers hidden: it is a single
    // picture, and a screen reader should hear it as one.
    <div
      role="img"
      aria-label="A cat asleep on a cushion on a café windowsill, beside a steaming cup and a stack of books, with rooftops and slow clouds through the glass."
      className={cn(
        "rounded-sheet border-rule bg-card shadow-hard relative overflow-hidden border",
        // The room's own ratio is the default; a caller that stretches this
        // (the sign-in screen does, to sit level with the column beside it)
        // passes its own sizing and the scene grows more wall to fill it.
        "aspect-[320/232]",
        className,
      )}
    >
      <canvas
        ref={canvas}
        width={SCENE_W}
        height={SCENE_H}
        aria-hidden="true"
        className="absolute inset-0 block h-full w-full [image-rendering:pixelated]"
      />
      <img
        // BASE_URL, not a bare "/", so the picture survives being served
        // from a subpath — same contract as the service worker in main.tsx.
        src={`${import.meta.env.BASE_URL}hero-cat.gif`}
        alt=""
        aria-hidden="true"
        data-cat
        width={CAT_W}
        height={CAT_H}
        decoding="async"
        // CAT_BOX places it for a box of the room's natural height, which
        // is also what a reader sees before the effect runs. In a taller box
        // mountCafeScene rewrites top/height, because that is the half that
        // knows how many rows of wall it added.
        className="absolute block [image-rendering:pixelated]"
        style={CAT_BOX}
      />
      {/* A vignette, and nothing more. Paper does not glow, and it does not
          get scanlines either. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 120% at 50% 34%, transparent 56%, color-mix(in oklab, var(--ink) 13%, transparent) 100%)",
        }}
      />
    </div>
  );
}
