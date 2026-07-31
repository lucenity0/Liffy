import type { Category } from "@/types/api";

/**
 * How each review category is spelled for a human, in one place.
 *
 * Split out of `badgeMaps.tsx` rather than exported from it: that file may
 * only export components (react-refresh would stop fast-refreshing it
 * otherwise), and #201's distribution chart needs these labels somewhere a
 * Badge does not fit. `badgeMaps` builds its category specs from this table,
 * so a chart and the badges directly above it on the same page cannot drift.
 *
 * The labels are short on purpose — they sit inside 11px chips and as axis
 * labels on a chart that has to survive a narrow window.
 */
export const CATEGORY_LABELS: Record<Category, string> = {
  logic_error: "Logic",
  security: "Security",
  performance: "Perf",
  architecture: "Architecture",
  convention: "Convention",
  improvement: "Improvement",
};

/**
 * Takes `string` rather than `Category` because `category_distribution` is
 * keyed by whatever the column holds — including the `"other"` bucket #193
 * appends for values outside the enum, which the backend permits because the
 * column is a plain `String` validated only at the Pydantic boundary.
 */
export function categoryLabel(value: string): string {
  return CATEGORY_LABELS[value as Category] ?? humanize(value);
}

/** `logic_error` → `logic error`. The last resort for an unknown enum value. */
export function humanize(value: string): string {
  return value.replace(/_/g, " ");
}
