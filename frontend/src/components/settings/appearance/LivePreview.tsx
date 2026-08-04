import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { ComponentSpec } from "@/lib/theme/components";

/**
 * A miniature Liffy, built out of the same tokens the real one is.
 *
 * The point is not fidelity for its own sake — it is that changing a setting
 * used to mean saving it, leaving Settings, finding a review, and forming an
 * opinion from memory of what it looked like before. Everything here is drawn
 * with `bg-card`, `border-rule`, `text-ink-dim`, `rounded-sheet` and the rest,
 * so it is not a picture of the app: it is the app's own stylesheet rendering
 * at a smaller size. A token that changes changes this, necessarily, because
 * there is no second set of values it could be reading.
 *
 * Every element the component registry names carries its `data-liffy`
 * attribute here too, which is what lets the inspector highlight a component
 * and the override rules reach it — the same selector does both jobs.
 */

export type PreviewSurface = "dashboard" | "reviews" | "analytics";

export function LivePreview({
  surface,
  onSurfaceChange,
  highlight,
}: {
  surface: PreviewSurface;
  onSurfaceChange: (surface: PreviewSurface) => void;
  /** The component the inspector has selected, outlined in place. */
  highlight?: ComponentSpec | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * Bring the highlighted component into view.
   *
   * Selecting from the palette is meant to feel like jumping to the thing,
   * and a highlight below the fold of a 420px panel is indistinguishable from
   * nothing happening. Scoped to the preview's own scroller, so it never
   * moves the settings page underneath it.
   */
  useEffect(() => {
    if (!highlight) return;
    const scroller = scrollRef.current;
    const target = scroller?.querySelector(`[data-liffy="${highlight.id}"]`);
    if (!scroller || !target) return;
    const box = scroller.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    scroller.scrollBy({
      top: rect.top - box.top - (box.height - rect.height) / 2,
      behavior: "smooth",
    });
  }, [highlight]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="label">Live preview</p>
        <div role="tablist" aria-label="Preview surface" className="flex gap-1">
          {(["dashboard", "reviews", "analytics"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={surface === id}
              onClick={() => onSurfaceChange(id)}
              className={cn(
                "rounded-chip px-2 py-1 text-2xs capitalize transition-colors duration-100",
                surface === id
                  ? "bg-neutral-tint text-ink"
                  : "text-ink-sub hover:text-ink",
              )}
            >
              {id}
            </button>
          ))}
        </div>
      </div>

      {/* The frame is chrome, not content: a hairline box with a rail down
          the side, so the miniature reads as a window onto the app rather
          than as more of the settings page. */}
      <div
        className="rounded-sheet flex min-h-0 flex-1 overflow-hidden border border-rule bg-paper"
        style={{ minHeight: "22rem" }}
      >
        <PreviewRail highlight={highlight} />

        <div
          ref={scrollRef}
          className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
        >
          {surface === "dashboard" && <DashboardPreview highlight={highlight} />}
          {surface === "reviews" && <ReviewsPreview highlight={highlight} />}
          {surface === "analytics" && <AnalyticsPreview highlight={highlight} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Whether a given registry id is the one selected.
 *
 * `outline` rather than `border` or `ring`: outlines do not participate in
 * layout, so lighting a component up cannot shift the thing next to it and
 * make the highlight read as a bug. Drawn by the preview rather than by the
 * component, so it stays visible through whatever the override does to that
 * component's own background and border.
 */
function lit(highlight: ComponentSpec | null | undefined, id: string) {
  return highlight?.id === id
    ? "outline-2 outline-offset-2 outline-ink"
    : undefined;
}

function PreviewRail({ highlight }: { highlight?: ComponentSpec | null }) {
  const items = ["Dashboard", "Reviews", "Repositories", "Analytics"];
  return (
    <nav
      aria-hidden="true"
      className="chrome-surface flex w-28 shrink-0 flex-col gap-0.5 border-r border-rule p-2"
    >
      <span className="label px-1 pb-1 text-2xs">Liffy</span>
      {items.map((item, index) => (
        <span
          key={item}
          data-liffy="sidebar-item"
          className={cn(
            "rounded-chip px-1.5 py-1 text-2xs",
            index === 0 ? "bg-recessed text-ink" : "text-ink-dim",
            lit(highlight, "sidebar-item"),
          )}
        >
          {item}
        </span>
      ))}
    </nav>
  );
}

function DashboardPreview({ highlight }: { highlight?: ComponentSpec | null }) {
  const metrics = [
    { label: "Reviews", value: "128" },
    { label: "Findings", value: "412" },
    { label: "Repos", value: "9" },
  ];

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            data-liffy="metric-card"
            className={cn(
              "rounded-sheet border border-rule bg-card p-2",
              lit(highlight, "metric-card"),
            )}
          >
            <p className="label text-2xs">{metric.label}</p>
            <p data-numeric className="text-lg text-ink">
              {metric.value}
            </p>
          </div>
        ))}
      </div>

      {["liffy/backend", "liffy/frontend"].map((repo) => (
        <div
          key={repo}
          data-liffy="dashboard-card"
          className={cn(
            "rounded-sheet shadow-hard border border-rule bg-card p-2.5",
            lit(highlight, "dashboard-card"),
          )}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-code text-sm text-ink">{repo}</span>
            <span className="text-2xs text-ink-sub">2h ago</span>
          </div>
          <div className="mt-1.5 flex gap-1">
            <Badge tone="oxide" label="3 critical" highlight={highlight} />
            <Badge tone="ochre" label="7 warning" highlight={highlight} />
          </div>
        </div>
      ))}
    </>
  );
}

function ReviewsPreview({ highlight }: { highlight?: ComponentSpec | null }) {
  const rows = [
    { pr: "#412", title: "Cache the retrieval index", tone: "sage" as const },
    { pr: "#411", title: "Drop the unused migration", tone: "ochre" as const },
    { pr: "#409", title: "Rework the token store", tone: "oxide" as const },
  ];

  return (
    <>
      <div
        data-liffy="review-header"
        className={cn(
          "rounded-sheet border border-rule bg-recessed p-2.5",
          lit(highlight, "review-header"),
        )}
      >
        <p className="label text-2xs">Pull request #412</p>
        <p className="mt-0.5 text-md text-ink">Cache the retrieval index</p>
        <div className="mt-1.5 flex gap-1">
          <Badge tone="sage" label="Approved" highlight={highlight} />
          <Badge tone="payne" label="4 files" highlight={highlight} />
        </div>
      </div>

      <div className="rounded-sheet overflow-hidden border border-rule">
        {rows.map((row) => (
          <div
            key={row.pr}
            data-liffy="review-row"
            className={cn(
              "flex items-baseline gap-2 border-b border-rule bg-card px-2.5 py-2 last:border-b-0",
              lit(highlight, "review-row"),
            )}
          >
            <span data-numeric className="font-code text-2xs text-ink-sub">
              {row.pr}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-ink-dim">
              {row.title}
            </span>
            <Badge tone={row.tone} label="•" highlight={highlight} />
          </div>
        ))}
      </div>
    </>
  );
}

function AnalyticsPreview({ highlight }: { highlight?: ComponentSpec | null }) {
  // Fixed heights, not random: the preview re-renders on every slider tick
  // and a chart that reshuffles under the cursor reads as the setting having
  // done something it did not do.
  const bars = [38, 62, 45, 78, 55, 88, 70, 52];

  return (
    <>
      <div
        data-liffy="analytics-chart"
        className={cn(
          "rounded-sheet shadow-hard border border-rule bg-card p-2.5",
          lit(highlight, "analytics-chart"),
        )}
      >
        <p className="label text-2xs">Findings per week</p>
        <div className="mt-2 flex h-20 items-end gap-1">
          {bars.map((height, index) => (
            <span
              key={index}
              className="flex-1 bg-payne"
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
      </div>

      <div
        data-liffy="settings-group"
        className={cn(
          "rounded-sheet border border-rule bg-card",
          lit(highlight, "settings-group"),
        )}
      >
        <div className="border-b border-rule px-2.5 py-2">
          <p className="label text-2xs">Review</p>
        </div>
        <div className="flex flex-col gap-1.5 p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-ink-dim">Model</span>
            <span className="font-code text-2xs text-ink">claude-opus-5</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-ink-dim">Post to GitHub</span>
            <span className="font-code text-2xs text-ink">off</span>
          </div>
        </div>
      </div>
    </>
  );
}

const TONES = {
  oxide: "bg-oxide-tint text-oxide",
  ochre: "bg-ochre-tint text-ochre",
  sage: "bg-sage-tint text-sage",
  payne: "bg-payne-tint text-payne",
} as const;

function Badge({
  tone,
  label,
  highlight,
}: {
  tone: keyof typeof TONES;
  label: string;
  highlight?: ComponentSpec | null;
}) {
  return (
    <span
      data-liffy="finding-badge"
      className={cn(
        "rounded-chip px-1.5 py-px text-2xs",
        TONES[tone],
        lit(highlight, "finding-badge"),
      )}
    >
      {label}
    </span>
  );
}
