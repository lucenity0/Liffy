import { Link } from "react-router-dom";
import { CategoryBadge, SeverityBadge } from "@/components/ui/badgeMaps";
import { ModelProse } from "@/components/ui/ModelProse";
import { Sheet } from "@/components/ui/Sheet";
import { useLatestFinding } from "@/hooks/useLatestFinding";
import {
  commentAnchorId,
  formatLineRange,
  severityEdge,
} from "@/lib/reviewUtils";
import { cn, formatAbsolute, formatRelative } from "@/lib/utils";

/**
 * The most recent thing Liffy actually caught.
 *
 * The band above this one counts reviews, which says a job ran. This says the
 * product works — and it is the only place on the dashboard where you read
 * Liffy's own words rather than a tally of them. Everything else here is
 * administration.
 *
 * Deliberately *one* finding, not a feed. A list of findings is the reviews
 * page; the point of this band is that it can be read in a glance on the way
 * to something else.
 *
 * Renders nothing while loading, on error, and when there is no finding yet.
 * All three are the same decision as `NeedsAttention`'s: the band's rule lives
 * on the `Band` wrapper in `Dashboard`, which is `empty:hidden`, so returning
 * null takes the separator with it. A skeleton here would reserve space for
 * something that may never arrive on a new account, and an error note would
 * be the loudest element on the page for the least important query on it —
 * nothing below depends on this, so a failure should be silent.
 */
export function LatestFinding() {
  const finding = useLatestFinding();

  if (!finding.data) return null;

  const { comment, review_id, pr_number, repo_full_name, reviewed_at } =
    finding.data;

  const lines = formatLineRange(comment.line_start, comment.line_end);

  return (
    <section className="flex flex-col gap-3" aria-label="Latest finding">
      <h2 className="label text-ink">Latest finding</h2>

      {/* Full width, deliberately, and not to be capped again. A shorter
          measure reads better in isolation and wrong here: every other
          element on this page — the band rules, the repo grid, the
          Connect repository button — ends at the same right edge, so a
          card that stops short of it reads as broken layout rather than
          as a column. Tried both ways; the grid wins over the measure. */}
      <Sheet>
        {/* The severity edge, matching `ReviewComment` on the detail page, so
            the same finding is the same colour in both places. */}
        <div
          className={cn(
            "flex flex-col gap-2 border-l-2 px-4 py-3",
            severityEdge(comment.severity),
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge value={comment.severity} />
            <CategoryBadge value={comment.category} />
            <span
              className="ml-auto font-code text-sm text-ink-sub"
              data-numeric
            >
              {comment.file_path}:{lines}
            </span>
          </div>

          <ModelProse text={comment.comment_text} />

          {/* Attribution last and quiet. The finding is the content; where it
              came from is provenance, and putting it first would make this
              read as another row of the reviews list. */}
          <p className="text-sm text-ink-sub">
            <Link
              to={`/reviews/${review_id}#${commentAnchorId(comment.id)}`}
              className="underline-offset-4 hover:text-ink hover:underline"
            >
              {repo_full_name} #{pr_number}
            </Link>
            {" · "}
            <time dateTime={reviewed_at} title={formatAbsolute(reviewed_at)}>
              {formatRelative(reviewed_at)}
            </time>
          </p>
        </div>
      </Sheet>
    </section>
  );
}

