import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { normalizeApiError } from "@/lib/errors";
import { formatAbsolute, formatRelative } from "@/lib/utils";
import type { RepoOut, RepoStatusOut } from "@/types/api";
import { IndexStatus } from "./IndexStatus";

/**
 * One connected repository, as a leaf of paper. Entirely presentational —
 * props in, callbacks out — so the container owns every hook and this stays
 * cheap to render in a test or the style guide.
 *
 * `POST /repos/{id}/index` returns 202 with nothing useful in it, so
 * `reindexQueued` is the only acknowledgement we can give. Without it the
 * button looks like it did nothing: the status chip will not flip to
 * "building" until the worker has actually picked the job up.
 */
export function RepoCard({
  repo,
  status,
  statusPending,
  onReindex,
  onDisconnect,
  reindexing = false,
  reindexQueued = false,
  reindexError,
  disconnecting = false,
}: {
  repo: RepoOut;
  status?: RepoStatusOut;
  statusPending?: boolean;
  onReindex: () => void;
  onDisconnect: () => void;
  reindexing?: boolean;
  reindexQueued?: boolean;
  reindexError?: unknown;
  disconnecting?: boolean;
}) {
  return (
    // No aria-label: a named <section> is a landmark, and one landmark per
    // repo would bury the real ones. The list item wrapper in RepoList is
    // what gives a screen reader the structure instead.
    <Sheet
      data-liffy="dashboard-card"
      className="flex flex-col transition-colors hover:border-rule-strong"
    >
      <Sheet.Body className="flex flex-1 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <Link
            to={`/repositories/${repo.id}`}
            className="font-code text-md leading-tight break-all text-ink underline-offset-4 hover:underline"
          >
            {repo.full_name}
          </Link>
          <p className="text-sm text-ink-sub">
            <span className="font-code">{repo.default_branch}</span>
            {" · connected "}
            <time
              dateTime={repo.created_at}
              title={formatAbsolute(repo.created_at)}
            >
              {formatRelative(repo.created_at)}
            </time>
          </p>
        </div>

        <IndexStatus
          status={status}
          isPending={statusPending}
          fallbackIndexedAt={repo.indexed_at}
        />
      </Sheet.Body>

      <Sheet.Footer className="flex-wrap gap-y-2">
        <Button onClick={onReindex} loading={reindexing}>
          Re-index
        </Button>
        <Button
          variant="danger"
          onClick={onDisconnect}
          loading={disconnecting}
        >
          Disconnect
        </Button>

        {reindexError ? (
          <p className="ml-auto text-sm text-oxide" role="status">
            {normalizeApiError(reindexError).message}
          </p>
        ) : (
          reindexQueued && (
            <p className="ml-auto text-sm text-sage" role="status">
              Re-index queued
            </p>
          )
        )}
      </Sheet.Footer>
    </Sheet>
  );
}
