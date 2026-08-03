import { PageHeader } from "@/components/ui/PageHeader";
import { NeedsAttention } from "@/components/repo/NeedsAttention";
import { RepoList } from "@/components/repo/RepoList";
import { RecentReviews } from "@/components/review/RecentReviews";

/**
 * The landing page: what Liffy is watching, and what it has written lately.
 *
 * Each section owns its own query and its own loading/empty/error states, so
 * a failing /repos does not blank out the reviews sitting next to it.
 */
export function Dashboard() {
  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Dashboard"
        description="Connected repositories, and the reviews Liffy has written most recently."
      />

      {/* First, and only when it has something to say — the point of a
          snapshot is that what is wrong reaches you before what is fine. */}
      <NeedsAttention />

      {/* Anchors, not decoration: the rail's Dashboard sub-items point here,
          so a section that loses its id silently turns a nav entry into a
          link to the top of the page. `scroll-mt` clears the sticky PageBar,
          which would otherwise sit over the heading you just jumped to. */}
      <div id="repositories" className="scroll-mt-16">
        <RepoList />
      </div>
      <div id="recent-reviews" className="scroll-mt-16">
        <RecentReviews />
      </div>
    </div>
  );
}
