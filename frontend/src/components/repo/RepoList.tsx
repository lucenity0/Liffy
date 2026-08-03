import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Modal } from "@/components/ui/Modal";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { useRepos } from "@/hooks/useRepos";
import { useRepoStatus } from "@/hooks/useRepoStatus";
import { useDisconnectRepo, useTriggerIndex } from "@/hooks/useRepoMutations";
import type { RepoOut } from "@/types/api";
import { ConnectRepoModal } from "./ConnectRepoModal";
import { RepoCard } from "./RepoCard";

/** A snapshot, not the whole list — /repositories is where everything lives. */
const SNAPSHOT = 4;

/**
 * The Repositories section: its own header, its own four states, and one card
 * per connected repo.
 *
 * Capped at four. Cards read well at three and fall apart at thirty, and the
 * dashboard's job is "what is happening across my instance", not repository
 * management — that moved to /repositories, which this points at as soon as
 * there is more here than fits.
 */
export function RepoList() {
  const repos = useRepos();
  const [connecting, setConnecting] = useState(false);
  const onConnect = () => setConnecting(true);

  const all = repos.data ?? [];
  const shown = all.slice(0, SNAPSHOT);

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center gap-3">
        <h2 className="label text-ink">Repositories</h2>
        {repos.data && (
          <span
            data-numeric
            className="rounded-full bg-rule px-1.5 py-px text-2xs text-ink-dim"
          >
            {all.length}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {all.length > 0 && (
            <ButtonLink to="/repositories" variant="ghost">
              View all →
            </ButtonLink>
          )}
          {/* Secondary, not primary: one filled button per page, and on the
              dashboard this is a section action sitting on bare paper — a
              solid dark block floating on the grid with no sheet behind it
              read as the loudest thing on a page it does not lead. */}
          <Button variant="secondary" onClick={onConnect}>
            Connect repository
          </Button>
        </div>
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
              <Button variant="primary" onClick={onConnect}>
                Connect your first repository
              </Button>
            }
          />
        </Sheet>
      )}

      {shown.length > 0 && (
        <>
          <ul aria-label="Repositories" className="grid gap-4 sm:grid-cols-2">
            {shown.map((repo) => (
              // `grid` on the item, so the single card child stretches to the
              // row height and its footer pins to the bottom — two cards with
              // different amounts of metadata still line up.
              <li key={repo.id} className="grid">
                <RepoCardWithStatus repo={repo} />
              </li>
            ))}
          </ul>
          {all.length > shown.length && (
            <p className="text-sm text-ink-dim">
              Showing {shown.length} of {all.length}.{" "}
              <Link to="/repositories" className="underline underline-offset-4">
                All repositories
              </Link>
              .
            </p>
          )}
        </>
      )}

      {connecting && (
        <ConnectRepoModal
          onClose={() => setConnecting(false)}
          knownRepoIds={new Set(repos.data?.map((repo) => repo.id))}
        />
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
