import { Sheet } from "@/components/ui/Sheet";
import { StatusBadge, VerdictBadge } from "@/components/ui/badgeMaps";
import { formatAbsolute, formatRelative } from "@/lib/utils";
import type { ReviewListItem } from "@/types/api";

/**
 * One review, as a row. Shared by the dashboard's recent list and the full
 * reviews table — the two differ in their container, not their row.
 *
 * `completed_at ?? created_at` is what gets shown: for a finished review the
 * interesting moment is when Liffy finished writing, and for one still in
 * flight there is nothing else to show.
 */
export function ReviewRow({ review }: { review: ReviewListItem }) {
  const timestamp = review.completed_at ?? review.created_at;

  return (
    // A plain <li> wrapper, not `display: contents` — that drops the list-item
    // role outright in several browsers, and the row's own flex layout is
    // unaffected by having a block parent.
    <li>
      <Sheet.Row
        to={`/reviews/${review.id}`}
        className="flex-wrap items-baseline gap-x-3 gap-y-1.5"
      >
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
      </Sheet.Row>
    </li>
  );
}
