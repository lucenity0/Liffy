import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Modal } from "@/components/ui/Modal";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { useRepos } from "@/hooks/useRepos";
import { useRepoStatus } from "@/hooks/useRepoStatus";
import { useDisconnectRepo, useTriggerIndex } from "@/hooks/useRepoMutations";
import type { RepoOut } from "@/types/api";
import { RepoCard } from "./RepoCard";

/**
 * The Repositories section: its own header, its own four states, and one card
 * per connected repo.
 *
 * `onConnect` is optional so this can ship before the connect modal exists —
 * absent, the button renders disabled rather than lying about being clickable.
 */
export function RepoList({ onConnect }: { onConnect?: () => void }) {
  const repos = useRepos();

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center gap-3">
        <h2 className="label text-ink">Repositories</h2>
        {repos.data && (
          <span
            data-numeric
            className="rounded-full bg-rule px-1.5 py-px text-2xs text-ink-dim"
          >
            {repos.data.length}
          </span>
        )}
        <Button
          variant="primary"
          onClick={onConnect}
          disabled={!onConnect}
          className="ml-auto"
        >
          Connect repository
        </Button>
      </header>

      {repos.isPending && <CardSkeletons />}

      {repos.isError && (
        <ErrorNote error={repos.error} onRetry={() => repos.refetch()} />
      )}

      {repos.data?.length === 0 && (
        <Sheet>
          <EmptyState
            title="No repositories yet."
            description="Connect a GitHub repository and Liffy will index it, then review every pull request that opens against it."
            action={
              <Button variant="primary" onClick={onConnect} disabled={!onConnect}>
                Connect repository
              </Button>
            }
          />
        </Sheet>
      )}

      {repos.data && repos.data.length > 0 && (
        <ul aria-label="Repositories" className="grid gap-4 sm:grid-cols-2">
          {repos.data.map((repo) => (
            // `grid` on the item, so the single card child stretches to the
            // row height and its footer pins to the bottom — two cards with
            // different amounts of metadata still line up.
            <li key={repo.id} className="grid">
              <RepoCardWithStatus repo={repo} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * `useRepoStatus` is per-repo, and hooks cannot be called in a loop — so the
 * mapping needs one component per row. It also means each card gets its own
 * mutation state, which is what makes only the clicked card show a spinner.
 *
 * The status query runs for *every* repo, not just un-indexed ones: the chunk
 * count only exists on this endpoint. The amplification the plan warns about
 * is polling, not fetching, and `refetchInterval` already returns false as
 * soon as a repo reads back "indexed" — so an indexed repo costs exactly one
 * request per mount and then goes quiet.
 */
function RepoCardWithStatus({ repo }: { repo: RepoOut }) {
  const [confirming, setConfirming] = useState(false);

  const status = useRepoStatus(repo.id);
  const reindex = useTriggerIndex();
  const disconnect = useDisconnectRepo();

  return (
    <>
      <RepoCard
        repo={repo}
        status={status.data}
        statusPending={status.isPending}
        onReindex={() => reindex.mutate(repo.id)}
        onDisconnect={() => setConfirming(true)}
        reindexing={reindex.isPending}
        reindexQueued={reindex.isSuccess}
        reindexError={reindex.error}
        disconnecting={disconnect.isPending}
      />

      {/* Mounted only while open, so N cards do not put N dialogs in the DOM.
          The plan allowed window.confirm here; we have a real Modal, and
          jsdom has no confirm() to test against anyway. */}
      {confirming && (
        <Modal
          open
          onClose={() => setConfirming(false)}
          title="Disconnect this repository?"
          description={repo.full_name}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button
                variant="danger"
                loading={disconnect.isPending}
                onClick={() =>
                  disconnect.mutate(repo.id, {
                    onSuccess: () => setConfirming(false),
                  })
                }
              >
                Disconnect
              </Button>
            </>
          }
        >
          <p className="text-base text-ink">
            Liffy stops reviewing its pull requests and drops the vector index.
            Past reviews are kept. You can reconnect it later, but it will need
            to be indexed again.
          </p>
          {disconnect.isError && (
            <ErrorNote error={disconnect.error} className="mt-3" />
          )}
        </Modal>
      )}
    </>
  );
}

function CardSkeletons() {
  return (
    <div className="grid gap-4 sm:grid-cols-2" aria-hidden="true">
      {[0, 1].map((i) => (
        <Sheet key={i}>
          <Sheet.Body className="flex flex-col gap-3">
            <Skeleton className="w-40" />
            <Skeleton className="w-24" />
            <Skeleton className="w-48" />
          </Sheet.Body>
          <Sheet.Footer>
            <Skeleton className="w-20" />
            <Skeleton className="w-24" />
          </Sheet.Footer>
        </Sheet>
      ))}
    </div>
  );
}
