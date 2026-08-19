import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { LatestFinding } from "@/components/dashboard/LatestFinding";
import { ThisWeek } from "@/components/dashboard/ThisWeek";
import { NeedsAttention } from "@/components/repo/NeedsAttention";
import { RepoList } from "@/components/repo/RepoList";
import { RecentReviews } from "@/components/review/RecentReviews";

/**
 * The landing page: what happened lately, and where Liffy needs you.
 *
 * Banded to `redesign-supporiting-md/heading_problem.md` — a ruled page
 * header, then figures, then the lists, each band opened by a rule. The
 * separators are the point: without them the sections read as one loose stack
 * floating under the title.
 *
 * The order is `ui_structure.md`'s: overview, needs attention, top
 * repositories, recent reviews.
 *
 * **Why the page exists at all.** It used to be four repositories lifted from
 * /repositories above five reviews lifted from /reviews, with nothing on it
 * that was not already somewhere else — a table of contents wearing a page's
 * clothes. The figure strip is its own answer, and the repositories below are
 * ranked by recent activity rather than merely truncated, so "top" means
 * something.
 *
 * Each section owns its own query and its own loading, empty and error
 * states, so a failing /repos does not blank out the reviews beside it.
 */
export function Dashboard() {
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Dashboard"
        description="What Liffy has been doing, and where it needs you."
      />

      {/* Unruled: the page header's own rule already closes the space above
          it, and a second line 8px under the first reads as a mistake. */}
      <Band>
        <ThisWeek />
      </Band>

      {/* Directly under the figures, above everything administrative: the
          first thing below the counts should be the thing being counted.
          Renders nothing until there is a finding, and the rule goes with it
          — same `empty:hidden` mechanism as the band below. */}
      <Band ruled>
        <LatestFinding />
      </Band>

      {/* Renders nothing at all when nothing is wrong — a permanently present
          "all clear" panel is a panel people stop reading. Its rule is drawn
          on this wrapper and disappears with it, which is why every band's
          rule sits on top rather than underneath: a trailing border would be
          left hanging under the section before it, pointing at nothing. */}
      <Band ruled>
        <NeedsAttention />
      </Band>

      <Band ruled>
        <RepoList />
      </Band>
      <Band ruled>
        <RecentReviews />
      </Band>
    </div>
  );
}

/**
 * One band of the page, with the rule that opens it.
 *
 * `empty:` is doing real work here, not defensive styling: `NeedsAttention`
 * decides internally that it has nothing to say and returns null, so the
 * wrapper still mounts and only CSS can see that what it wraps came to
 * nothing. Without it a healthy account gets a rule with a gap under it.
 */
function Band({ children, ruled }: { children: ReactNode; ruled?: boolean }) {
  return (
    <div
      className={
        ruled
          ? "border-t border-rule pt-8 pb-2 empty:hidden"
          : "pt-6 pb-2 empty:hidden"
      }
    >
      {children}
    </div>
  );
}
