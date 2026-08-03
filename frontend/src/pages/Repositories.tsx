import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Input } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { IndexBadge } from "@/components/ui/badgeMaps";
import { ConnectRepoModal } from "@/components/repo/ConnectRepoModal";
import { useRepos } from "@/hooks/useRepos";
import { useRepoStatuses } from "@/hooks/useRepoStatuses";
import { formatAbsolute, formatCount, formatRelative } from "@/lib/utils";
import type { IndexStatus, RepoListItem, RepoStatusOut } from "@/types/api";

type Filter = "all" | IndexStatus;

/**
 * The real enum, and only the real enum.
 *
 * The brief's mockup includes a FAILED row, but `IndexStatus` is
 * `indexed | indexing | not_indexed` and inventing a fourth state would mean
 * a second status model living beside the backend's. A partially-indexed
 * repository is a real thing the API *does* report — see `partialCount` — but
 * it is "some files were skipped", not "indexing failed", and it is said
 * separately rather than mislabelled.
 */
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "indexed", label: "Indexed" },
  { id: "indexing", label: "Indexing" },
  { id: "not_indexed", label: "Not indexed" },
];

/**
 * Every connected repository, as a dense list.
 *
 * The dashboard showed these as cards, which reads well at three and falls
 * apart at thirty — this is the surface that has to scale, so the dashboard
 * keeps a snapshot and the management view lives here.
 */
export function Repositories() {
  const repos = useRepos();
  const [connecting, setConnecting] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const repoIds = useMemo(
    () => repos.data?.map((repo) => repo.id) ?? [],
    [repos.data],
  );
  const statuses = useRepoStatuses(repoIds);

  const counts = useMemo(() => {
    const tally: Record<Filter, number> = {
      all: repos.data?.length ?? 0,
      indexed: 0,
      indexing: 0,
      not_indexed: 0,
    };
    for (const status of statuses.byId.values()) tally[status.status]++;
    return tally;
  }, [repos.data, statuses.byId]);

  /** Repos whose *last* index run skipped files — partial, not failed. */
  const partialCount = useMemo(
    () =>
      [...statuses.byId.values()].filter(
        (status) => (status.last_index_failed_files ?? 0) > 0,
      ).length,
    [statuses.byId],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (repos.data ?? []).filter((repo) => {
      if (needle && !repo.full_name.toLowerCase().includes(needle)) return false;
      if (filter === "all") return true;
      return statuses.byId.get(repo.id)?.status === filter;
    });
  }, [repos.data, query, filter, statuses.byId]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Repositories"
        description="Repositories Liffy can access and review."
        actions={
          <Button variant="primary" onClick={() => setConnecting(true)}>
            Connect repository
          </Button>
        }
      />

      {repos.isError && (
        <ErrorNote error={repos.error} onRetry={() => repos.refetch()} />
      )}

      {repos.isPending && (
        <Sheet>
          <Sheet.Header title="Repositories" />
          <SkeletonRows rows={4} />
        </Sheet>
      )}

      {repos.data && repos.data.length === 0 && (
        <Sheet>
          <EmptyState
            title="No repositories connected."
            description="Connect a GitHub repository to let Liffy index the codebase and review pull requests with repository context."
            action={
              <Button variant="primary" onClick={() => setConnecting(true)}>
                Connect repository
              </Button>
            }
          />
        </Sheet>
      )}

      {repos.data && repos.data.length > 0 && (
        <>
          {/* A status strip, not four dashboard cards. One bordered row of
              counts, in the same register as the review severity counts. */}
          <ul className="grid grid-cols-2 divide-rule rounded-sheet border border-rule sm:grid-cols-4 sm:divide-x">
            <Stat label="Repositories" value={counts.all} />
            <Stat label="Indexed" value={counts.indexed} />
            <Stat label="Indexing" value={counts.indexing} />
            {/* The fourth cell says something true rather than filling the
                grid: partial if any, otherwise what is left to do. */}
            {partialCount > 0 ? (
              <Stat label="Partially indexed" value={partialCount} />
            ) : (
              <Stat label="Not indexed" value={counts.not_indexed} />
            )}
          </ul>

          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search repositories…"
              aria-label="Search repositories"
              className="w-full sm:w-64"
            />
            <div role="group" aria-label="Filter by index status" className="flex flex-wrap gap-1.5">
              {FILTERS.map((option) => (
                <Button
                  key={option.id}
                  size="sm"
                  variant={filter === option.id ? "primary" : "secondary"}
                  aria-pressed={filter === option.id}
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                  <span data-numeric className="ml-1.5 opacity-70">
                    {counts[option.id]}
                  </span>
                </Button>
              ))}
            </div>
          </div>

          <Sheet aria-label="Repositories">
            <Sheet.Header title="Repositories" count={visible.length} />

            {visible.length === 0 ? (
              <EmptyState
                title="No repositories found."
                description={
                  query
                    ? `No repositories match “${query}”.`
                    : "No repositories in this state."
                }
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <>
                {/* A real header, because these are real columns. Hidden on
                    narrow screens, where the row stacks instead. */}
                <div
                  aria-hidden="true"
                  className={`${ROW_GRID} hidden border-b border-rule px-4 py-2 lg:grid`}
                >
                  <span className="label">Repository</span>
                  <span className="label">Index</span>
                  <span className="label text-right">Reviews</span>
                  <span className="label text-right">Last review</span>
                  <span className="label text-right">Last indexed</span>
                </div>
                <Sheet.List as="ul">
                  {visible.map((repo) => (
                    <RepoRow
                      key={repo.id}
                      repo={repo}
                      status={statuses.byId.get(repo.id)}
                    />
                  ))}
                </Sheet.List>
              </>
            )}
          </Sheet>
        </>
      )}

      {connecting && (
        <ConnectRepoModal
          onClose={() => setConnecting(false)}
          knownRepoIds={new Set(repos.data?.map((repo) => repo.id))}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex flex-col gap-0.5 px-4 py-3">
      <span data-numeric className="font-hand text-xl leading-none text-ink">
        {value}
      </span>
      <span className="label">{label}</span>
    </li>
  );
}

/**
 * Fixed columns, not a right-aligned pile.
 *
 * These used to be flex children with `ml-auto` on the last one, so the whole
 * middle group floated against the row's right edge — and since "yesterday",
 * "5 hours ago" and "never indexed" are wildly different widths, every row's
 * badge and chunk count landed at a different x. The list looked ragged for a
 * reason that had nothing to do with the repositories in it.
 */
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_7rem_5rem_8rem_8rem] items-baseline gap-x-4";

/**
 * One repository, as a row.
 *
 * Columns follow `repo_tab_ui.md`: Repository, Index, Reviews, Last review —
 * plus Last indexed, which was already here and is worth its width. The chunk
 * count moved down into the sub-line under the name: it is index detail, and
 * a sixth column would have cost the repository name the space it needs more.
 *
 * The review figures used to be absent with a note saying they would cost a
 * paginated query per repository. They now arrive on `GET /repos` itself, as
 * one grouped subquery — see `RepoListItemOut`.
 */
function RepoRow({
  repo,
  status,
}: {
  repo: RepoListItem;
  status: RepoStatusOut | undefined;
}) {
  const indexedAt = status?.indexed_at ?? repo.indexed_at;
  const skipped = status?.last_index_failed_files ?? 0;

  return (
    <li>
      <Link
        to={`/repositories/${repo.id}`}
        className={`${ROW_GRID} px-4 py-3 text-ink no-underline hover:bg-recessed focus-visible:bg-recessed max-lg:flex max-lg:flex-wrap max-lg:gap-y-1`}
      >
        <span className="min-w-0">
          <span className="block truncate font-code text-base">
            {repo.full_name}
          </span>
          <span className="block truncate font-code text-2xs text-ink-sub">
            {repo.default_branch}
            {status ? ` · ${formatCount(status.chunk_count)} chunks` : ""}
            {/* Said plainly, and only when true: a partial index means reviews
                touching those files retrieve no context. */}
            {skipped > 0 ? ` · ${formatCount(skipped)} skipped` : ""}
          </span>
        </span>

        <span>{status ? <IndexBadge value={status.status} /> : null}</span>

        {/* A real zero, not a dash. "Connected but never reviewed" is a fact
            the list knows, and it is the state this column exists to expose. */}
        <span className="text-sm text-ink-dim lg:text-right" data-numeric>
          {formatCount(repo.review_count)}
        </span>

        <span className="text-sm whitespace-nowrap text-ink-dim lg:text-right">
          {repo.last_review_at ? (
            <time
              dateTime={repo.last_review_at}
              title={formatAbsolute(repo.last_review_at)}
            >
              {formatRelative(repo.last_review_at)}
            </time>
          ) : (
            "never"
          )}
        </span>

        <span className="text-sm whitespace-nowrap text-ink-sub lg:text-right">
          {indexedAt ? (
            <time dateTime={indexedAt} title={formatAbsolute(indexedAt)}>
              {formatRelative(indexedAt)}
            </time>
          ) : (
            "never"
          )}
        </span>
      </Link>
    </li>
  );
}
