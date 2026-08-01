import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { FigureTile, MetricTile } from "@/components/analytics/MetricTile";
import { useAnalyticsSummary } from "@/hooks/useAnalyticsSummary";
import { formatCount, formatPercent, formatSeconds } from "@/lib/utils";
import type { AnalyticsSummaryOut } from "@/types/api";

/**
 * Is Liffy hitting its own targets?
 *
 * Report §8.1 is a table of metrics against thresholds, and until now it
 * existed only as JSON you had to curl. Every threshold on this page comes
 * off the response — `Metric` carries `target` and `comparison` precisely so
 * that a change to §8.1 does not need a frontend release.
 *
 * The charts (category distribution, severity calibration, the token-
 * efficiency trend, flagged reviews) are #201, on top of this.
 */
export function Analytics() {
  const summary = useAnalyticsSummary();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-hand text-2xl leading-tight text-ink">Analytics</h1>
        <p className="text-base text-ink-dim">
          Report §8.1's evaluation metrics, measured against their targets.
        </p>
      </header>

      {summary.isPending ? (
        <TileSkeletons />
      ) : summary.isError ? (
        // In place of the page body — the shell, its nav and the theme toggle
        // are chrome and stay put.
        <ErrorNote error={summary.error} onRetry={() => summary.refetch()} />
      ) : (
        <Summary data={summary.data} />
      )}
    </div>
  );
}

function Summary({ data }: { data: AnalyticsSummaryOut }) {
  /**
   * The one whole-page empty state, and it is narrow on purpose: no reviews
   * at all means every tile would read "—", which looks broken rather than
   * new. The moment a single review exists, the page switches to per-tile
   * unknowns — which is the state it will spend most of its life in, since
   * durations arrive long before anybody rates a comment.
   */
  if (data.reviews_total === 0) {
    return (
      <Sheet>
        <EmptyState
          title="Nothing to measure yet."
          description="Connect a repository and let Liffy review a pull request. The §8.1 metrics fill in from there."
          action={<ButtonLink to="/">Connect a repository</ButtonLink>}
        />
      </Sheet>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Counts data={data} />

      <div className="grid gap-4 sm:grid-cols-2">
        <MetricTile
          label="Approval rate"
          metric={data.approval_rate}
          format={formatPercent}
          unit="rated comments"
          unknownHint="Rate the comments on a review to start measuring this."
          caption={
            /**
             * The false-positive rate appears here, as the complement it is,
             * rather than as a second tile with its own pass/fail badge.
             *
             * `comment_feedback` records no *reason* for a thumbs-down, so it
             * is exactly `1 - approval` (ADR 004). Two tiles would show one
             * number twice — and between 70% and 80% approval they would show
             * a pass and a fail for the same clicks. The figure is still on
             * the page, because §8.1 asks for it; the judgement is made once.
             */
            <>
              False positives:{" "}
              <span data-numeric>
                {data.false_positive_rate.value === null
                  ? "—"
                  : formatPercent(data.false_positive_rate.value)}
              </span>{" "}
              (target &lt; {formatPercent(data.false_positive_rate.target)}). A
              thumbs-down records no reason, so this is the inverse of the
              approval rate rather than a second reading of it.
            </>
          }
        />

        <MetricTile
          label="Time to review"
          metric={data.time_to_review_ms}
          format={formatSeconds}
          unit="reviews with a receipt"
          unknownHint="Measured from webhook receipt, so only webhook-triggered reviews carry it."
          caption={
            /**
             * The queue wait, spelled out. It is the difference between the
             * two clocks and the reason both are on the page — `duration_ms`
             * measures `run_review`'s internals and cannot see the time a job
             * spent sitting in Celery.
             *
             * The issue text asks for a caption saying this is a lower bound
             * "until #197 lands". #197 landed (PR #204), so `time_to_review_ms`
             * above is the real end-to-end figure and this is the lower bound
             * beside it — which is what #194's contract settled on.
             */
            <>
              Pipeline alone:{" "}
              <span data-numeric>
                {data.pipeline_duration_ms_median === null
                  ? "—"
                  : formatSeconds(data.pipeline_duration_ms_median)}
              </span>
              . The difference is queue wait, which the pipeline clock cannot
              see.
            </>
          }
        />

        <FigureTile
          label="Token efficiency"
          value={data.token_efficiency}
          format={(value) => value.toFixed(3)}
          unknownHint="Needs a review with both a token count and at least one rating."
          caption="Mean approval rate per 1,000 tokens. §8.1 tracks this as a trend rather than against a threshold."
        />
      </div>
    </div>
  );
}

/** Run counts. Not §8.1 metrics — the denominator everything else sits in. */
function Counts({ data }: { data: AnalyticsSummaryOut }) {
  return (
    <Sheet aria-label="Reviews run">
      <Sheet.Body className="flex flex-wrap gap-x-8 gap-y-3">
        <Count label="Reviews" value={data.reviews_total} />
        <Count label="Completed" value={data.reviews_completed} />
        <Count label="Failed" value={data.reviews_failed} />
      </Sheet.Body>
    </Sheet>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="font-hand text-xl leading-none text-ink" data-numeric>
        {formatCount(value)}
      </p>
      <p className="label text-ink-dim">{label}</p>
    </div>
  );
}

/**
 * Skeletons in the tile layout rather than a centred spinner: the number of
 * tiles is known before the request resolves, so the page can hold its shape
 * and stop the content jumping when it lands.
 */
function TileSkeletons() {
  return (
    <div className="flex flex-col gap-4">
      <Sheet>
        <Sheet.Body className="flex flex-wrap gap-x-8 gap-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-20" />
          ))}
        </Sheet.Body>
      </Sheet>
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Sheet key={i}>
            <Sheet.Header title={<Skeleton className="w-28" />} />
            <Sheet.Body className="flex flex-col gap-2">
              <Skeleton className="h-7 w-24" />
              <Skeleton className="w-40" />
            </Sheet.Body>
          </Sheet>
        ))}
      </div>
    </div>
  );
}
