import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Sheet } from "@/components/ui/Sheet";
import type { Metric } from "@/types/api";

/**
 * One §8.1 metric against its target.
 *
 * **Three states, not two.** A `null` value is *unknown*, not missed — the
 * distinction #191 returns `null` to preserve, carried all the way to the
 * screen. `met` is `null` exactly when `value` is, so this branches on `met`
 * and never on truthiness.
 *
 * **No threshold is typed here.** `target` and `comparison` come off the
 * response, so if §8.1 moves, this file does not. If you find yourself
 * writing `0.7`, the contract is being ignored. (`ReviewScores` is the one
 * place that cannot do this — `EvalScoresOut` carries no target.)
 */
export function MetricTile({
  label,
  metric,
  format,
  unit,
  caption,
  unknownHint,
}: {
  label: string;
  metric: Metric;
  /** Applied to both the value and the target, so they read in one unit. */
  format: (value: number) => string;
  /** How the sample is counted — "reviews", "rated comments". */
  unit: string;
  /** Extra prose under the number. Where a metric's caveats go. */
  caption?: ReactNode;
  /** What would make an unknown metric known. */
  unknownHint?: string;
}) {
  const unknown = metric.value === null;
  const comparator = metric.comparison === "gt" ? ">" : "<";

  return (
    <Sheet aria-label={label} className="flex flex-col">
      <Sheet.Header title={label} />

      <Sheet.Body className="flex grow flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="font-hand text-2xl leading-none text-ink" data-numeric>
            {/* An em dash, not "0" and not "—%": there is no number here, and
                a formatted zero is a claim the data does not make. */}
            {unknown ? "—" : format(metric.value!)}
          </p>
          <StateBadge met={metric.met} />
        </div>

        {/* `ink-dim` (5.2:1) for every caption on this page. `ink-sub` is
            marked LARGE TEXT AND NON-TEXT ONLY at 3.2:1 in index.css. */}
        {/* `data-numeric` on the line rather than on an inner span: the whole
            line is figures, and tabular numerals line the target up with the
            sample size below it. */}
        <p className="text-sm text-ink-dim" data-numeric>
          Target {comparator} {format(metric.target)}
          {" · "}
          {/* Always shown. n is routinely single digits here, and a rate
              without its sample invites a conclusion it cannot support. */}
          {metric.sample_size} {unit}
        </p>

        {unknown && unknownHint && (
          <p className="text-sm text-ink-dim">{unknownHint}</p>
        )}

        {caption && <div className="mt-auto pt-1 text-sm text-ink-dim">{caption}</div>}
      </Sheet.Body>
    </Sheet>
  );
}

/**
 * A figure with no target attached.
 *
 * Deliberately not a `MetricTile` with the badge hidden: a metric that §8.1
 * sets no threshold for is a different thing from one that has a threshold
 * and cannot be evaluated, and a tile that can render either would eventually
 * render the wrong one.
 */
export function FigureTile({
  label,
  value,
  format,
  caption,
  unknownHint,
}: {
  label: string;
  value: number | null;
  format: (value: number) => string;
  caption?: ReactNode;
  unknownHint?: string;
}) {
  return (
    <Sheet aria-label={label} className="flex flex-col">
      <Sheet.Header title={label} />
      <Sheet.Body className="flex grow flex-col gap-2">
        <p className="font-hand text-2xl leading-none text-ink" data-numeric>
          {value === null ? "—" : format(value)}
        </p>
        {value === null && unknownHint && (
          <p className="text-sm text-ink-dim">{unknownHint}</p>
        )}
        {caption && <div className="mt-auto pt-1 text-sm text-ink-dim">{caption}</div>}
      </Sheet.Body>
    </Sheet>
  );
}

/**
 * Never colour-only. Each state carries the word as well as the tone, so the
 * tile survives greyscale, a colour-vision difference, and a screen reader.
 *
 * `--sage` met / `--oxide` missed / neutral unknown, which is the pairing
 * already bound to those meanings across the app.
 */
function StateBadge({ met }: { met: boolean | null }) {
  if (met === null) {
    return (
      <Badge tone="neutral" size="md">
        Not measured yet
      </Badge>
    );
  }
  return (
    <Badge tone={met ? "sage" : "oxide"} size="md">
      {met ? "Meets target" : "Below target"}
    </Badge>
  );
}
