import { Link } from "react-router-dom";
import { Sheet } from "@/components/ui/Sheet";
import { useRepos } from "@/hooks/useRepos";
import { useRepoStatuses } from "@/hooks/useRepoStatuses";
import { formatCount } from "@/lib/utils";
import type { RepoOut, RepoStatusOut } from "@/types/api";

interface Item {
  to: string;
  what: string;
  why: string;
  tone: "oxide" | "ochre";
}

/**
 * The things that are quietly wrong.
 *
 * A repository that never finished indexing still accepts pull requests and
 * still produces reviews — they are just reviews written without repository
 * context, which is the one thing Liffy is for. Nothing on the dashboard used
 * to say so; you had to open each card and read its badge.
 *
 * Everything here is derived from data the page already has, and the section
 * renders nothing at all when there is nothing wrong. A permanently-present
 * "all clear" panel is a panel people stop reading.
 */
export function NeedsAttention() {
  const repos = useRepos();
  const repoIds = repos.data?.map((repo) => repo.id) ?? [];
  const statuses = useRepoStatuses(repoIds);

  const items = (repos.data ?? []).flatMap((repo) =>
    itemsFor(repo, statuses.byId.get(repo.id)),
  );

  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="label text-ink">Needs attention</h2>
      <Sheet aria-label="Needs attention">
        <Sheet.List as="ul">
          {items.map((item) => (
            <li key={`${item.to}-${item.what}`}>
              <Sheet.Row to={item.to} className="flex-wrap gap-y-1">
                <span
                  aria-hidden="true"
                  className={`size-1.5 shrink-0 rounded-full ${
                    item.tone === "oxide" ? "bg-oxide" : "bg-ochre"
                  }`}
                />
                <span className="min-w-0 font-code text-base break-all">
                  {item.what}
                </span>
                <span className="ml-auto text-sm text-ink-dim">{item.why}</span>
              </Sheet.Row>
            </li>
          ))}
        </Sheet.List>
        <Sheet.Footer>
          <p className="text-sm text-ink-dim">
            <Link to="/repositories" className="underline underline-offset-4">
              All repositories
            </Link>
          </p>
        </Sheet.Footer>
      </Sheet>
    </section>
  );
}

function itemsFor(repo: RepoOut, status: RepoStatusOut | undefined): Item[] {
  if (!status) return [];

  if (status.status === "not_indexed") {
    return [
      {
        to: `/repositories/${repo.id}?tab=index`,
        what: repo.full_name,
        why: "Not indexed — reviews here have no repository context",
        tone: "oxide",
      },
    ];
  }

  // Partial, not failed. The API has no failed index state, and a run that
  // skipped some files is a different fact from one that fell over.
  const skipped = status.last_index_failed_files ?? 0;
  if (skipped > 0) {
    const seen = status.last_indexed_files_seen;
    return [
      {
        to: `/repositories/${repo.id}?tab=index`,
        what: repo.full_name,
        why: `${formatCount(skipped)}${seen ? ` of ${formatCount(seen)}` : ""} files skipped when indexing`,
        tone: "ochre",
      },
    ];
  }

  return [];
}
