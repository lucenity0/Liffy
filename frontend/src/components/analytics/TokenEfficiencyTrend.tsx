import { Sheet } from "@/components/ui/Sheet";
import { formatAbsolute } from "@/lib/utils";
import type { TokenEfficiencyPoint } from "@/types/api";

/**
 * Approval rate per 1,000 tokens, over time. §8.1 tracks this as a trend
 * rather than against a threshold, and a trend is a claim about shape that
 * no single number can make.
 *
 * The honest part of this component is what it refuses to draw. A line
 * between two points is a trend; a line from one point is a decoration that
 * looks like evidence.
 */

/**
 * Below this, points are drawn without a line joining them.
 *
 * Three is the fewest that can show a direction rather than a single step.
 * The chart says which it is rather than leaving the reader to count dots.
 */
const MIN_POINTS_FOR_A_LINE = 3;

const WIDTH = 320;
const HEIGHT = 72;
const PAD = 6;

export function TokenEfficiencyTrend({
  points,
  reviewsCompleted,
}: {
  points: TokenEfficiencyPoint[];
  /**
   * For the coverage caption. A point needs both a token count and at least
   * one rating, so this series is routinely far shorter than the run count —
   * and a chart with three dots must not imply there were only ever three
   * reviews.
   */
  reviewsCompleted: number;
}) {
  return (
    <Sheet aria-label="Token efficiency trend">
      <Sheet.Header title="Token efficiency trend" />
      <Sheet.Body className="flex flex-col gap-3">
        {points.length === 0 ? (
          <p className="text-sm text-ink-dim">
            Nothing to plot yet. A point needs a review with both a token count
            and at least one rating.
          </p>
        ) : (
          <Plot points={points} />
        )}

        <p className="text-sm text-ink-dim">
          {coverage(points.length, reviewsCompleted)}
        </p>
      </Sheet.Body>
    </Sheet>
  );
}

function Plot({ points }: { points: TokenEfficiencyPoint[] }) {
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  /**
   * Guarded twice. A single point makes `max - min` zero, and so does a flat
   * series — both give `NaN` y-coordinates, which SVG silently renders as
   * nothing. A degenerate range draws down the middle instead.
   */
  const span = max - min;
  const y = (value: number) =>
    span === 0
      ? HEIGHT / 2
      : HEIGHT - PAD - ((value - min) / span) * (HEIGHT - PAD * 2);
  const x = (index: number) =>
    points.length === 1
      ? WIDTH / 2
      : PAD + (index / (points.length - 1)) * (WIDTH - PAD * 2);

  const line = points.length >= MIN_POINTS_FOR_A_LINE;

  return (
    <svg
      role="img"
      aria-label={summarize(points)}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="w-full"
      // No mount animation. On a metrics page it reads as jitter, and it
      // makes every test that asserts a shape race the transition.
    >
      {line && (
        <polyline
          points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")}
          fill="none"
          className="stroke-ink-dim"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}

      {/* Points always, line only when there are enough of them. With one or
          two, the dots are the whole honest content of the chart. */}
      {points.map((point, index) => (
        <circle
          key={point.review_id}
          cx={x(index)}
          cy={y(point.value)}
          r={line ? 2 : 3.5}
          className="fill-ink"
        >
          <title>
            {point.value.toFixed(3)} · {formatAbsolute(point.created_at)}
          </title>
        </circle>
      ))}
    </svg>
  );
}

/**
 * Says how much of the run history the chart actually covers.
 *
 * Without this a three-dot chart reads as "Liffy has run three reviews",
 * when the truth is that only three of them have both a token count and a
 * rating.
 */
function coverage(plotted: number, reviewsCompleted: number): string {
  if (plotted === 0) {
    return `None of ${reviewsCompleted} completed reviews has both a token count and a rating yet.`;
  }
  if (plotted < MIN_POINTS_FOR_A_LINE) {
    return `${plotted} of ${reviewsCompleted} completed reviews qualif${plotted === 1 ? "ies" : "y"} — too few to draw a trend, so these are points rather than a line.`;
  }
  return `${plotted} of ${reviewsCompleted} completed reviews qualify. A review counts only once it has both a token count and at least one rating.`;
}

function summarize(points: TokenEfficiencyPoint[]): string {
  const values = points.map((point) => point.value.toFixed(3)).join(", ");
  return points.length === 1
    ? `Token efficiency: a single measurement of ${values}.`
    : `Token efficiency over ${points.length} reviews, oldest first: ${values}.`;
}
