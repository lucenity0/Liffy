import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Modal } from "@/components/ui/Modal";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { IndexStatus } from "@/components/repo/IndexStatus";
import { ReviewRow } from "@/components/review/ReviewRow";
import { useRepos } from "@/hooks/useRepos";
import { useRepoStatus } from "@/hooks/useRepoStatus";
import { useDisconnectRepo, useTriggerIndex } from "@/hooks/useRepoMutations";
import { useReviews } from "@/hooks/useReviews";
import { normalizeApiError } from "@/lib/errors";
import { formatAbsolute, formatRelative } from "@/lib/utils";

/**
 * One repository: what Liffy knows about it, and what it has reviewed there.
 *
 * There is no `GET /repos/{id}`, so the repo itself comes out of the list —
 * which the dashboard has usually already cached, making this instant on the
 * common path and one request on a cold deep link.
 */
export function RepoDetail() {
  const { repoId = "" } = useParams();
  const navigate = useNavigate();

  const repos = useRepos();
  const repo = repos.data?.find((candidate) => candidate.id === repoId);

  const status = useRepoStatus(repoId, { enabled: Boolean(repo) });
  const reindex = useTriggerIndex();
  const disconnect = useDisconnectRepo();
  const [confirming, setConfirming] = useState(false);

  const reviews = useReviews({ limit: 20 });
  /**
   * Filtered client-side, because GET /reviews takes no repo parameter. That
   * makes this the newest 20 reviews *overall* that happen to be this repo's,
   * not its newest 20 — which is why the footer says so rather than implying
   * a complete list.
   */
  const repoReviews =
    repo && reviews.data
      ? reviews.data.filter((review) => review.repo_full_name === repo.full_name)
      : [];

  if (repos.isPending) return <RepoSkeleton />;

  if (repos.isError) {
    return <ErrorNote error={repos.error} onRetry={() => repos.refetch()} />;
  }

  if (!repo) {
    return (
      <Sheet>
        <EmptyState
          title="No repository filed under that id."
          description="It may have been disconnected, or the link may be wrong."
          action={<ButtonLink to="/">Dashboard</ButtonLink>}
        />
      </Sheet>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h1 className="font-code text-xl leading-tight break-all text-ink">
            {repo.full_name}
          </h1>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              onClick={() => reindex.mutate(repo.id)}
              loading={reindex.isPending}
            >
              Re-index
            </Button>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          </div>
        </div>

        <p className="text-sm text-ink-sub">
          <span className="font-code">{repo.default_branch}</span>
          {" · connected "}
          <time dateTime={repo.created_at} title={formatAbsolute(repo.created_at)}>
            {formatRelative(repo.created_at)}
          </time>
        </p>

        <IndexStatus
          status={status.data}
          isPending={status.isPending}
          fallbackIndexedAt={repo.indexed_at}
        />

        {reindex.isError ? (
          <p role="status" className="text-base text-oxide">
            {normalizeApiError(reindex.error).message}
          </p>
        ) : (
          reindex.isSuccess && (
            <p role="status" className="text-base text-sage">
              Re-index queued.
            </p>
          )
        )}
      </header>

      <Sheet aria-label="Reviews">
        <Sheet.Header title="Reviews" count={repoReviews.length} />

        {reviews.isPending && <SkeletonRows rows={3} />}

        {reviews.isError && (
          <Sheet.Body>
            <ErrorNote error={reviews.error} onRetry={() => reviews.refetch()} />
          </Sheet.Body>
        )}

        {reviews.data && repoReviews.length === 0 && (
          <EmptyState
            title="Nothing reviewed here yet."
            description="Open a pull request against this repository, or trigger a review by hand."
            action={<ButtonLink to="/reviews">All reviews</ButtonLink>}
          />
        )}

        {repoReviews.length > 0 && (
          <>
            <Sheet.List as="ul" aria-label={`Reviews for ${repo.full_name}`}>
              {repoReviews.map((review) => (
                <ReviewRow key={review.id} review={review} detailed />
              ))}
            </Sheet.List>
            <Sheet.Footer>
              <p className="text-sm text-ink-dim">
                Drawn from the most recent reviews across every repository — see
                all reviews for the full history.
              </p>
            </Sheet.Footer>
          </>
        )}
      </Sheet>

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
                    // This page is about to be about a repo that no longer
                    // exists, so leave before that happens.
                    onSuccess: () => navigate("/"),
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
    </div>
  );
}

function RepoSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-72" />
        <Skeleton className="w-48" />
        <Skeleton className="w-40" />
      </div>
      <Sheet>
        <Sheet.Header title="Reviews" />
        <SkeletonRows rows={3} />
      </Sheet>
    </div>
  );
}
