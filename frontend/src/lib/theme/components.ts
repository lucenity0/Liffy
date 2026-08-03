/**
 * The components Appearance lets you override, and the knobs each one takes.
 *
 * A hand-written list rather than something derived from the component tree,
 * and that is the design. Every entry here is a promise: this thing exists in
 * the preview, it carries `data-liffy="<id>"` in the real app, and the knobs
 * listed are the ones that visibly do something to it. A registry generated
 * from the tree would offer `padding` on a chart axis and `shadow` on a
 * table row — controls that do nothing when you drag them, which is worse
 * than not offering them.
 *
 * Adding a component is two edits: an entry here, and `data-liffy="<id>"` on
 * the element in the app. `components.test.ts` checks the second half, so a
 * registry entry with nothing to style fails rather than shipping as a dead
 * search result.
 */

import type { ComponentOverride } from "@/lib/theme/appearance";

/** The knobs, in the order the editor shows them. */
export const KNOBS = [
  "background",
  "border",
  "ink",
  "radius",
  "padding",
  "weight",
  "shadow",
] as const;

export type Knob = (typeof KNOBS)[number];

export interface ComponentSpec {
  /** Matches `data-liffy` in the app and in the preview. */
  id: string;
  label: string;
  /** One line on what it is, shown under the label in the palette. */
  note: string;
  /** Which preview surface to scroll to when this is selected. */
  surface: "dashboard" | "reviews" | "analytics";
  /** Extra words the ⌘K search should match. Nobody types "settings-group". */
  aliases: string[];
  knobs: readonly Knob[];
}

export const COMPONENTS: readonly ComponentSpec[] = [
  {
    id: "dashboard-card",
    label: "Repository Card",
    note: "One repository on the dashboard.",
    surface: "dashboard",
    aliases: ["repo", "repository", "card", "tile"],
    knobs: ["background", "border", "radius", "padding", "shadow"],
  },
  {
    id: "metric-card",
    label: "Metric Card",
    note: "The number tiles across the top.",
    surface: "dashboard",
    aliases: ["stat", "kpi", "number", "tile", "count"],
    knobs: ["background", "border", "ink", "radius", "padding", "shadow"],
  },
  {
    id: "review-header",
    label: "Review Header",
    note: "Title and verdict at the top of a review.",
    surface: "reviews",
    aliases: ["pr", "pull request", "title", "verdict", "header"],
    knobs: ["background", "border", "ink", "radius", "padding", "weight"],
  },
  {
    id: "review-row",
    label: "Review Row",
    note: "One line in the reviews table.",
    surface: "reviews",
    aliases: ["table", "row", "list", "line"],
    knobs: ["background", "border", "ink", "padding"],
  },
  {
    id: "finding-badge",
    label: "Finding Badge",
    note: "Critical, warning and info pills.",
    surface: "reviews",
    aliases: ["badge", "pill", "chip", "severity", "critical", "tag"],
    knobs: ["background", "border", "ink", "radius", "padding", "weight"],
  },
  {
    id: "sidebar-item",
    label: "Sidebar Item",
    note: "One row in the navigation rail.",
    surface: "dashboard",
    aliases: ["nav", "rail", "menu", "link"],
    knobs: ["background", "ink", "radius", "padding", "weight"],
  },
  {
    id: "analytics-chart",
    label: "Analytics Chart",
    note: "The chart panel and its plot area.",
    surface: "analytics",
    aliases: ["graph", "plot", "bar", "chart", "trend"],
    knobs: ["background", "border", "radius", "padding", "shadow"],
  },
  {
    id: "settings-group",
    label: "Settings Group",
    note: "A titled block of settings, like this one.",
    surface: "analytics",
    aliases: ["sheet", "panel", "group", "section", "form"],
    knobs: ["background", "border", "radius", "padding", "shadow"],
  },
];

const BY_ID = new Map(COMPONENTS.map((spec) => [spec.id, spec]));

export function componentSpec(id: string): ComponentSpec | undefined {
  return BY_ID.get(id);
}

/**
 * Ranked search for the ⌘K palette.
 *
 * Scored rather than filtered so "card" puts Repository Card above Metric
 * Card instead of listing them in registry order — a palette that returns
 * the right four results in the wrong order still costs a read of all four.
 * An empty query returns everything, which is what makes ⌘K usable as a
 * browse affordance and not only a search one.
 */
export function searchComponents(query: string): readonly ComponentSpec[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return COMPONENTS;

  return COMPONENTS.map((spec) => ({ spec, score: score(spec, needle) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.spec.label.localeCompare(b.spec.label))
    .map((hit) => hit.spec);
}

function score(spec: ComponentSpec, needle: string): number {
  const label = spec.label.toLowerCase();
  if (label === needle) return 100;
  if (label.startsWith(needle)) return 80;
  if (spec.id.startsWith(needle)) return 70;
  if (label.includes(needle)) return 60;
  if (spec.id.includes(needle)) return 50;

  for (const alias of spec.aliases) {
    if (alias === needle) return 45;
    if (alias.startsWith(needle)) return 35;
    if (alias.includes(needle)) return 20;
  }
  if (spec.note.toLowerCase().includes(needle)) return 10;
  return 0;
}

/** Drops knobs a component does not accept — an imported theme may carry them. */
export function pruneOverride(
  id: string,
  override: ComponentOverride,
): ComponentOverride {
  const spec = componentSpec(id);
  if (!spec) return {};
  const out: ComponentOverride = {};
  for (const knob of spec.knobs) {
    const value = override[knob];
    if (value !== undefined) {
      // Each knob's value type is its own; the spec list is the only thing
      // narrowing here, so the assignment is widened deliberately.
      (out as Record<string, unknown>)[knob] = value;
    }
  }
  return out;
}
