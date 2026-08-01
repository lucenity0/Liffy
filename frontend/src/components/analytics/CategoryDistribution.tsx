import { Sheet } from "@/components/ui/Sheet";
import { categoryLabel } from "@/lib/categories";
import type { Category } from "@/types/api";

/**
 * How Liffy's comments spread across the six categories, against §8.1's
 * "even spread" target.
 *
 * Hand-rolled SVG — see #200 for the reasoning. This is `<rect>`s over a
 * linear scale; a charting runtime would arrive with its own typography and
 * palette to be fought back to these tokens.
 *
 * **Monochrome bars, distinguished by label and position.** `badgeMaps.tsx`
 * carries a written decision that categories do not get colour — severity is
 * what you triage by, so severity is what carries hue — and six new hues here
 * would contradict a decision the codebase argued for, on the same page as
 * the badges that follow it. The issue asks not to introduce a second mapping,
 * and this is what honouring the existing one looks like.
 */

/** Enum order, so a zero-count category still has a defined place. */
const CATEGORIES: Category[] = [
  "logic_error",
  "security",
  "performance",
  "architecture",
  "convention",
  "improvement",
];

const ROW = 28; // --rule-step, so the bars sit on the page's ruled pitch.
const BAR = 16;
/**
 * The label gutter, in viewBox units.
 *
 * Sized for the longest label rather than eyeballed: the type is monospace at
 * 12.5 units, so ~7.5 units a character, and "Architecture" is 12 of them —
 * 90, plus the 8-unit gap before the bar. At 96 the "A" fell outside the
 * viewBox and was silently clipped, which no test caught because the text
 * node was still in the DOM.
 */
const LABEL_W = 112;
const COUNT_W = 28;
const WIDTH = 348; // viewBox units; the SVG scales to its container.

export function CategoryDistribution({
  distribution,
}: {
  distribution: Record<string, number>;
}) {
  const rows = toRows(distribution);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const max = Math.max(...rows.map((row) => row.count), 0);
  /**
   * Where an even spread would put every bar. `rows.length` rather than a
   * literal 6 — a non-zero `other` bucket adds a seventh row, and the line
   * has to describe the chart actually on screen.
   */
  const even = rows.length > 0 ? total / rows.length : 0;

  const plotW = WIDTH - LABEL_W - COUNT_W;
  /**
   * Guarded. Every scale on this page has a plausible empty domain, and
   * `count / 0` is `NaN`, which SVG renders as nothing at all — no error, no
   * bar, no clue why.
   */
  const scale = (value: number) => (max === 0 ? 0 : (value / max) * plotW);

  return (
    <Sheet aria-label="Category distribution">
      <Sheet.Header title="Category distribution" />
      <Sheet.Body className="flex flex-col gap-3">
        <svg
          // `role="img"` with a label that carries the numbers: the <text>
          // inside an image role is not announced, so a bare chart is silent.
          role="img"
          aria-label={summarize(rows, total)}
          // viewBox + no width attribute, so it scales to a narrow window
          // rather than forcing the page to scroll sideways.
          viewBox={`0 0 ${WIDTH} ${rows.length * ROW}`}
          className="w-full"
        >
          {/* The target, drawn rather than described. "Even spread" is a
              claim about shape, and a number in a caption alone leaves the
              reader doing the comparison by eye against nothing. */}
          {max > 0 && even > 0 && (
            <line
              x1={LABEL_W + scale(even)}
              x2={LABEL_W + scale(even)}
              y1={0}
              y2={rows.length * ROW}
              className="stroke-rule-strong"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
          )}

          {rows.map((row, index) => {
            const y = index * ROW;
            return (
              <g key={row.key}>
                <text
                  x={LABEL_W - 8}
                  y={y + ROW / 2}
                  textAnchor="end"
                  dominantBaseline="central"
                  // 12px, and `ink-dim` at 5.2:1 — `ink-sub` is marked
                  // LARGE TEXT AND NON-TEXT ONLY at 3.2:1.
                  className="fill-ink-dim text-sm"
                >
                  {row.label}
                </text>

                {/* A zero-count category still gets a hairline stub, so the
                    row reads as "zero" rather than as a bar that failed to
                    render. The exact count beside it is what carries the
                    value either way. */}
                <rect
                  x={LABEL_W}
                  y={y + (ROW - BAR) / 2}
                  width={Math.max(scale(row.count), 1)}
                  height={BAR}
                  rx={2}
                  className={
                    row.count === 0
                      ? "fill-rule-strong"
                      : "fill-ink-dim opacity-80"
                  }
                />

                <text
                  x={LABEL_W + Math.max(scale(row.count), 1) + 6}
                  y={y + ROW / 2}
                  dominantBaseline="central"
                  className="fill-ink text-sm"
                >
                  {row.count}
                </text>
              </g>
            );
          })}
        </svg>

        <p className="text-sm text-ink-dim">
          {total === 0
            ? "No comments yet, so there is no spread to judge."
            : `The target is an even spread across categories. Across ${rows.length} categories and ${total} comment${total === 1 ? "" : "s"}, even would be about ${even.toFixed(1)} each — the dashed line.`}
        </p>
      </Sheet.Body>
    </Sheet>
  );
}

interface Row {
  key: string;
  label: string;
  count: number;
}

/**
 * The six known categories plus, last, a non-zero `other`.
 *
 * Zeros are kept deliberately. #193 fills them in against the enum rather
 * than trusting `GROUP BY`, which drops categories that never fired, and
 * "0 security comments" is the finding — a chart that omits empty bars throws
 * away the most interesting thing the evaluation layer has said so far.
 *
 * `other` is appended rather than sorted in: it is a bucket for values
 * outside the enum, not a seventh category, and it appears only when non-zero.
 */
function toRows(distribution: Record<string, number>): Row[] {
  const known = CATEGORIES.map((key) => ({
    key,
    label: categoryLabel(key),
    count: distribution[key] ?? 0,
  }))
    // Descending, ties broken by label — otherwise the six zero-count bars
    // reshuffle between renders and the chart looks alive when it is not.
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const other = distribution.other ?? 0;
  return other > 0
    ? [...known, { key: "other", label: categoryLabel("other"), count: other }]
    : known;
}

/** The whole chart as one sentence, for anyone who cannot see it. */
function summarize(rows: Row[], total: number): string {
  if (total === 0) return "Category distribution: no comments yet.";
  const parts = rows.map((row) => `${row.label} ${row.count}`).join(", ");
  return `Category distribution across ${total} comments: ${parts}.`;
}
