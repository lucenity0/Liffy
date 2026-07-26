import { Sheet } from "@/components/ui/Sheet";
import { StatusBadge, VerdictBadge } from "@/components/ui/badgeMaps";
import { cn, formatAbsolute, formatCount, formatRelative } from "@/lib/utils";
import type { ReviewListItem } from "@/types/api";

/**
 * One review, as a row. Shared by the dashboard's recent list and the full
 * reviews table — the two differ in how much of the row they show, not in
 * what a row is.
 *
 * `completed_at ?? created_at` is what gets shown: for a finished review the
 * interesting moment is when Liffy finished writing, and for one still in
 * flight there is nothing else to show.
 */
export function ReviewRow({
  review,
  detailed = false,
}: {
  review: ReviewListItem;
  /** Adds the summary line and the model/token metadata. */
  detailed?: boolean;
}) {
  const timestamp = review.completed_at ?? review.created_at;

  return (
    // A plain <li> wrapper, not `display: contents` — that drops the list-item
    // role outright in several browsers, and the row's own flex layout is
    // unaffected by having a block parent.
    <li>
      <Sheet.Row
        to={`/reviews/${review.id}`}
        className={cn(
          "flex-col items-stretch gap-1.5",
          // A failed review is worth spotting while scanning, but it is not
          // an alert — the same 9% wash the badges use, nothing louder.
          review.status === "failed" && "bg-oxide-tint",
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <span className="font-code text-base text-ink">
            {review.repo_full_name}
            <span className="text-ink-sub"> #</span>
            <span data-numeric>{review.pr_number}</span>
          </span>

          <StatusBadge value={review.status} />
          {review.verdict && <VerdictBadge value={review.verdict} />}

          <time
            dateTime={timestamp}
            title={formatAbsolute(timestamp)}
            className="ml-auto text-sm whitespace-nowrap text-ink-sub"
          >
            {formatRelative(timestamp)}
          </time>
        </div>

        {detailed && (review.summary || review.model_used) && (
          <div className="flex flex-wrap items-baseline gap-x-3">
            {/* Radon here and nowhere else in the row: the summary is the one
                part a model wrote, and the handwriting is what says so. */}
            {review.summary && (
              <p className="min-w-0 flex-1 truncate font-hand text-base text-ink-dim">
                {review.summary}
              </p>
            )}
            {review.model_used && (
              <p className="text-sm whitespace-nowrap text-ink-sub">
                {review.model_used}
                {review.tokens_used !== null && (
                  <>
                    {" · "}
                    <span data-numeric>{formatCount(review.tokens_used)}</span>
                    {" tokens"}
                  </>
                )}
              </p>
            )}
          </div>
        )}
      </Sheet.Row>
    </li>
  );
}
