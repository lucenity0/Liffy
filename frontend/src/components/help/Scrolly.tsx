import { useRef } from "react";
import { useScrollProgress } from "@/lib/scrolly";

/** The numbered progress rail across the top of a scrubbed figure. */
export function Rail({ steps, stage }: { steps: string[]; stage: number }) {
  return (
    <ol className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
      {steps.map((label, i) => (
        <li
          key={label}
          aria-current={i === stage}
          className={[
            "flex items-baseline gap-1.5 text-2xs transition-colors duration-200",
            i === stage ? "text-ink" : i < stage ? "text-ink-dim" : "text-ink-sub",
          ].join(" ")}
        >
          <span data-numeric>{String(i + 1).padStart(2, "0")}</span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Track + sticky frame. Children receive the 0..1 progress value.
 *
 * `height` is in viewport units and decides how much scrolling the sequence
 * costs. Shorter than the landing page's 360vh: this sits inside an answer
 * someone is reading, and a diagram that holds the page hostage for three and
 * a half screens is a diagram people learn to scroll straight past.
 */
export function ScrollyTrack({
  height = "220vh",
  label,
  children,
}: {
  height?: string;
  label: string;
  children: (progress: number) => React.ReactNode;
}) {
  const track = useRef<HTMLDivElement>(null);
  const progress = useScrollProgress(track);

  return (
    <div ref={track} style={{ height }} className="relative -mx-1" aria-label={label}>
      <div className="sticky top-20">{children(progress)}</div>
    </div>
  );
}
