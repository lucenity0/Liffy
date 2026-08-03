import { Link } from "react-router-dom";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { VerdictBadge } from "@/components/ui/badgeMaps";
import { useModelAnalytics } from "@/hooks/useModelAnalytics";
import { formatCount, formatPercent } from "@/lib/utils";
import type { ModelComparisonRow, ModelPerformanceRow } from "@/types/api";

/**
 * Which model is worth running.
 *
 * Everything here is per *review*, because that is the unit a model is chosen
 * in: what one review costs, and how much it finds. Nothing is per comment —
 * a model that writes twice as many comments is not twice as good, and an
 * average that rewarded it would say so.
 */
export function ModelsPanel({ active }: { active: boolean }) {
  const analytics = useModelAnalytics(active);

  if (analytics.isPending) {
    return (
      <Sheet>
        <Sheet.Header title="Model performance" />
        <SkeletonRows rows={3} />
      </Sheet>
    );
  }

  if (analytics.isError) {
    return (
      <ErrorNote error={analytics.error} onRetry={() => analytics.refetch()} />
    );
  }

  const { models, comparisons } = analytics.data;

  if (models.length === 0) {
    return (
      <Sheet>
        <EmptyState
          title="No completed reviews yet."
          description="Once Liffy has finished a review, this compares whichever models you run against each other."
        />
      </Sheet>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Sheet aria-label="Model performance">
        <Sheet.Header title="Model performance" count={models.length} />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-rule text-left">
                <th scope="col" className="label px-4 py-2 font-normal">
                  Model
                </th>
                <Numeric as="th">Reviews</Numeric>
                <Numeric as="th">Useful</Numeric>
                <Numeric as="th">Avg comments</Numeric>
                <Numeric as="th">Avg tokens</Numeric>
              </tr>
            </thead>
            <tbody>
              {models.map((row) => (
                <ModelRow key={row.model} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      </Sheet>

      {/* Only when there is something to compare. This table gets data one
          way — re-reviewing a pull request after switching model, which
          leaves both results against the same PR — so on most accounts it is
          legitimately empty and should not render as a broken panel. */}
      {comparisons.length > 0 && (
        <Sheet aria-label="Same-PR comparisons">
          <Sheet.Header title="Same pull request, two models" count={comparisons.length} />
          <Sheet.List as="ul">
            {comparisons.map((row) => (
              <Comparison key={row.pr_id} row={row} />
            ))}
          </Sheet.List>
        </Sheet>
      )}
    </div>
  );
}

function Numeric({
  as: Tag,
  children,
}: {
  as: "th" | "td";
  children: React.ReactNode;
}) {
  return (
    <Tag
      scope={Tag === "th" ? "col" : undefined}
      data-numeric
      className={
        Tag === "th"
          ? "label px-4 py-2 text-right font-normal"
          : "px-4 py-2.5 text-right whitespace-nowrap"
      }
    >
      {children}
    </Tag>
  );
}

function ModelRow({ row }: { row: ModelPerformanceRow }) {
  return (
    <tr className="border-b border-rule align-baseline last:border-b-0">
      <td className="px-4 py-2.5">
        {/* Not the label idiom: it uppercases, and a model name is a proper
            noun — "CLAUDE-OPUS-5" is simply wrong. */}
        <code className="font-code text-xs break-all text-ink">{row.model}</code>
      </td>
      <Numeric as="td">{row.reviews}</Numeric>
      <Numeric as="td">
        {row.useful_rate === null ? (
          // Not 0%. Nobody has voted, which is a different fact.
          <span className="text-ink-sub" title="No comments rated yet">
            —
          </span>
        ) : (
          <>
            {formatPercent(row.useful_rate)}
            {/* n travels with the rate: a percentage off one rating should
                look like one. */}
            <span className="ml-1 text-2xs text-ink-sub">
              /{row.rated_comments}
            </span>
          </>
        )}
      </Numeric>
      <Numeric as="td">{row.avg_comments}</Numeric>
      <Numeric as="td">
        {row.avg_tokens === null ? (
          <span className="text-ink-sub">—</span>
        ) : (
          formatCount(row.avg_tokens)
        )}
      </Numeric>
    </tr>
  );
}

function Comparison({ row }: { row: ModelComparisonRow }) {
  return (
    <li>
      <Sheet.Row className="flex-col items-stretch gap-2">
        <p className="font-code text-base text-ink">
          {row.repo_full_name}
          <span className="text-ink-sub"> #</span>
          <span data-numeric>{row.pr_number}</span>
        </p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {row.reviews.map((review) => (
            <li
              key={review.review_id}
              className="rounded-chip flex flex-col gap-1 border border-rule px-3 py-2"
            >
              <code className="font-code text-2xs break-all text-ink-dim">
                {review.model}
              </code>
              <span className="flex flex-wrap items-center gap-2">
                {review.verdict && <VerdictBadge value={review.verdict} />}
                <span data-numeric className="text-sm text-ink-dim">
                  {review.comments} finding{review.comments === 1 ? "" : "s"}
                  {review.tokens_used !== null &&
                    ` · ${formatCount(review.tokens_used)} tokens`}
                </span>
              </span>
              <Link
                to={`/reviews/${review.review_id}`}
                className="w-fit text-2xs text-ink-dim underline underline-offset-4 hover:text-ink"
              >
                Open review →
              </Link>
            </li>
          ))}
        </ul>
      </Sheet.Row>
    </li>
  );
}
