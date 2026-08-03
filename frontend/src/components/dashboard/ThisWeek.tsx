import { Link } from "react-router-dom";
import { SectionHeader } from "@/components/ui/PageHeader";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Skeleton } from "@/components/ui/Skeleton";
import { ACTIVITY_DAYS, useActivity } from "@/hooks/useActivity";
import { formatCount } from "@/lib/utils";

/**
 * The dashboard's opening figures: what actually happened lately.
 *
 * The page below it is two lists, both of which are also whole pages of their
 * own — so without this the dashboard was a truncated copy of /repositories
 * stacked on a truncated copy of /reviews, and there was no reason to be on
 * it. These three counts exist nowhere else, and they answer the question you
 * open the app with: has anything been happening.
 *
 * Counts rather than the rates on /analytics. An approval rate of 88% reads
 * exactly the same on a busy week and on a dead one.
 *
 * Bare figures on the page, not tiles in Sheets — `repo_tab_ui.md` is
 * explicit that this must not become four dashboard cards, and three boxed
 * numerals would outweigh the reviews they are summarising.
 */
export function ThisWeek() {
  const activity = useActivity();

  // Written from the response, not from the constant it was requested with. If
  // the two ever disagree, a heading reading "this week" over a month of data
  // is the failure — and it would look entirely fine on screen.
  const days = activity.data?.days ?? ACTIVITY_DAYS;
  const title = days === 7 ? "This week" : `Last ${days} days`;

  return (
    <section
      id="this-week"
      // Named, so the strip is a landmark a screen reader can jump to and
      // skip — three bare numerals are the least useful thing on the page to
      // read linearly.
      aria-label={title}
      className="flex scroll-mt-16 flex-col gap-3"
    >
      <SectionHeader
        title={title}
        actions={
          <Link
            to="/analytics"
            className="text-sm text-ink-dim underline underline-offset-4 hover:text-ink"
          >
            Analytics →
          </Link>
        }
      />

      {activity.isError ? (
        <ErrorNote error={activity.error} onRetry={() => activity.refetch()} />
      ) : (
        <dl className="flex flex-wrap gap-x-12 gap-y-4">
          <Figure
            label="Reviews"
            value={activity.data?.reviews}
            pending={activity.isPending}
          />
          <Figure
            label="Findings"
            value={activity.data?.findings}
            pending={activity.isPending}
          />
          <Figure
            label="Repositories"
            value={activity.data?.repositories}
            pending={activity.isPending}
          />
        </dl>
      )}
    </section>
  );
}

/**
 * A number over its name — the figure leads and the label explains it, which
 * is the opposite of every other list on this page and is what makes the
 * strip scan in one pass.
 *
 * `<dt>`/`<dd>` reversed visually but not in source order: the name is the
 * term and the count is the value, whatever the layout does.
 */
function Figure({
  label,
  value,
  pending,
}: {
  label: string;
  value: number | undefined;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col-reverse gap-1">
      <dt className="label text-ink-sub">{label}</dt>
      <dd className="font-hand text-2xl leading-none text-ink" data-numeric>
        {pending ? (
          <Skeleton className="w-10" />
        ) : (
          // A real zero, not a dash. Nothing happened is a measurement here —
          // unlike the analytics rates, where zero data and a zero rate are
          // genuinely different facts.
          formatCount(value ?? 0)
        )}
      </dd>
    </div>
  );
}
