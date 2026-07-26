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
      <header className="flex flex-col gap-1">
        <h1 className="font-hand text-2xl leading-tight text-ink">Dashboard</h1>
        <p className="text-base text-ink-dim">
          Connected repositories, and the reviews Liffy has written most
          recently.
        </p>
      </header>

      <RepoList />
      <RecentReviews />
    </div>
  );
}
