import type { Severity } from "@/types/api";

/**
 * Worst-first ordering. `satisfies` keeps it exhaustive: a new severity fails
 * typecheck here rather than silently sorting to the end.
 */
export const SEVERITY_RANK = {
  critical: 0,
  warning: 1,
  info: 2,
} satisfies Record<Severity, number>;

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity] ?? 99;
}
