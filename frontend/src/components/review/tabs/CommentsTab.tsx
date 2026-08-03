import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Sheet } from "@/components/ui/Sheet";
import { ReviewComment } from "@/components/review/ReviewComment";
import { ReviewScores } from "@/components/review/ReviewScores";
import { severityCounts } from "@/lib/reviewStats";
import { severityRank } from "@/lib/reviewUtils";
import { cn } from "@/lib/utils";
import type { ReviewCommentOut, Severity } from "@/types/api";

type Filter = "all" | Severity;

const ORDER: Severity[] = ["critical", "warning", "info"];

/**
 * Everything Liffy flagged, in one place, filterable by severity.
 *
 * Sorted worst-first across the whole review rather than grouped by file:
 * this tab answers "what did it find", and the Files tab is where the same
 * findings sit next to their code.
 */
export function CommentsTab({
  comments,
  reviewId,
  hasDiff,
  onViewInDiff,
}: {
  comments: ReviewCommentOut[];
  reviewId: string;
  /** No diff stored means "view in diff" has nowhere to go. */
  hasDiff: boolean;
  onViewInDiff: (comment: ReviewCommentOut) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const counts = severityCounts(comments);

  const sorted = useMemo(
    () =>
      [...comments].sort(
        (a, b) =>
          severityRank(a.severity) - severityRank(b.severity) ||
          a.file_path.localeCompare(b.file_path) ||
          a.line_start - b.line_start,
      ),
    [comments],
  );

  const visible =
    filter === "all" ? sorted : sorted.filter((c) => c.severity === filter);

  if (comments.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <Sheet aria-label="Comments">
          <EmptyState
            title="Nothing flagged."
            description="Liffy read the diff and had no line-level comments."
          />
        </Sheet>
        {/* Still rendered with nothing to rate: the score panel is what says
            "no ratings yet" out loud, and dropping it here would leave the
            reader unsure whether the review was scored at all. */}
        <ReviewScores reviewId={reviewId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Only severities the review actually contains get a filter, plus
          All. Offering "Critical 0" as a button that leads to an empty list
          is a worse answer than the summary tab's zero, which at least
          reads as reassurance rather than a dead control. */}
      <div role="group" aria-label="Filter by severity" className="flex flex-wrap gap-1.5">
        <FilterChip
          label="All"
          count={comments.length}
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        {ORDER.filter((severity) => counts[severity] > 0).map((severity) => (
          <FilterChip
            key={severity}
            label={severity}
            count={counts[severity]}
            active={filter === severity}
            onClick={() => setFilter(severity)}
          />
        ))}
      </div>

      <Sheet aria-label="Comments">
        <Sheet.List as="ul" className="divide-y divide-rule">
          {visible.map((comment) => (
            <li key={comment.id}>
              <ReviewComment
                comment={comment}
                reviewId={reviewId}
                onReveal={hasDiff ? onViewInDiff : undefined}
              />
            </li>
          ))}
        </Sheet.List>
      </Sheet>

      {/* The score belongs with the thing it scores. It used to sit under the
          summary, which meant rating a comment and watching the rate move
          were on opposite ends of a long page — and would now be on different
          tabs entirely. */}
      <ReviewScores reviewId={reviewId} />
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant={active ? "primary" : "secondary"}
      aria-pressed={active}
      onClick={onClick}
      className={cn("capitalize")}
    >
      {label}
      <span data-numeric className="ml-1.5 opacity-70">
        {count}
      </span>
    </Button>
  );
}
