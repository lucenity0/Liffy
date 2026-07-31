import { Badge, type BadgeTone, type BadgeVariant } from "./Badge";
import { CATEGORY_LABELS, humanize } from "@/lib/categories";
import type {
  Category,
  IndexStatus,
  ReviewStatus,
  Severity,
  Verdict,
} from "@/types/api";

/**
 * The four backend enums, mapped onto Badge's visual vocabulary.
 *
 * `satisfies Record<Enum, BadgeSpec>` is the point: if `Category` ever gains
 * a seventh member, typecheck fails *here*, at the map, which is exactly
 * where you want to be told.
 *
 * Every wrapper falls back rather than assuming exhaustiveness at runtime.
 * The backend types these columns as plain `str` and the LLM fills them in,
 * so an unrecognised value has to render as a neutral badge showing the raw
 * string — not crash, and not render blank.
 */

interface BadgeSpec {
  label: string;
  tone: BadgeTone;
  variant?: BadgeVariant;
  dot?: boolean;
  pulse?: boolean;
}

const STATUS = {
  pending: { label: "Pending", tone: "neutral", dot: true },
  processing: { label: "Processing", tone: "ochre", dot: true, pulse: true },
  completed: { label: "Completed", tone: "sage", dot: true },
  failed: { label: "Failed", tone: "oxide", dot: true },
} satisfies Record<ReviewStatus, BadgeSpec>;

const VERDICT = {
  approve: { label: "Approve", tone: "sage" },
  request_changes: { label: "Request changes", tone: "oxide" },
  comment: { label: "Comment", tone: "payne" },
} satisfies Record<Verdict, BadgeSpec>;

const SEVERITY = {
  critical: { label: "Critical", tone: "oxide", variant: "solid" },
  warning: { label: "Warning", tone: "ochre" },
  info: { label: "Info", tone: "payne" },
} satisfies Record<Severity, BadgeSpec>;

/**
 * Categories are deliberately monochrome — a departure from issue #131,
 * which asks for six distinct hues.
 *
 * Severity is what you triage by, so severity is the thing that carries
 * colour. Six more hues for category would be exactly the visual noise this
 * design rules out, and would drown the severity signal sitting next to it.
 *
 * Labels come from `lib/categories.ts` so #201's distribution chart can spell
 * them the same way without a second mapping. Still written out one key at a
 * time rather than mapped over that table — the `satisfies` below is the
 * point of this file, and a programmatic build would lose it.
 */
const CATEGORY = {
  logic_error: { label: CATEGORY_LABELS.logic_error, tone: "neutral", variant: "outline" },
  security: { label: CATEGORY_LABELS.security, tone: "neutral", variant: "outline" },
  performance: { label: CATEGORY_LABELS.performance, tone: "neutral", variant: "outline" },
  architecture: { label: CATEGORY_LABELS.architecture, tone: "neutral", variant: "outline" },
  convention: { label: CATEGORY_LABELS.convention, tone: "neutral", variant: "outline" },
  improvement: { label: CATEGORY_LABELS.improvement, tone: "neutral", variant: "outline" },
} satisfies Record<Category, BadgeSpec>;

const INDEX = {
  indexed: { label: "Indexed", tone: "sage", dot: true },
  not_indexed: { label: "Indexing", tone: "ochre", dot: true, pulse: true },
} satisfies Record<IndexStatus, BadgeSpec>;

/** Shown when the API hands us a value outside the union. */
function fallback(value: string): BadgeSpec {
  return { label: humanize(value), tone: "neutral" };
}

function render(spec: BadgeSpec, size: "sm" | "md") {
  return (
    <Badge
      tone={spec.tone}
      variant={spec.variant}
      dot={spec.dot}
      pulse={spec.pulse}
      size={size}
    >
      {spec.label}
    </Badge>
  );
}

type WrapperProps<T> = { value: T; size?: "sm" | "md" };

export function StatusBadge({ value, size = "sm" }: WrapperProps<ReviewStatus>) {
  return render(STATUS[value] ?? fallback(value), size);
}

export function VerdictBadge({ value, size = "sm" }: WrapperProps<Verdict>) {
  return render(VERDICT[value] ?? fallback(value), size);
}

export function SeverityBadge({ value, size = "sm" }: WrapperProps<Severity>) {
  return render(SEVERITY[value] ?? fallback(value), size);
}

export function CategoryBadge({ value, size = "sm" }: WrapperProps<Category>) {
  return render(CATEGORY[value] ?? fallback(value), size);
}

export function IndexBadge({ value, size = "sm" }: WrapperProps<IndexStatus>) {
  return render(INDEX[value] ?? fallback(value), size);
}
