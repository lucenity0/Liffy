import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Modal } from "@/components/ui/Modal";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { TabPanel, Tabs, type TabSpec } from "@/components/ui/Tabs";
import { IndexBadge } from "@/components/ui/badgeMaps";
import { IndexStatus } from "@/components/repo/IndexStatus";
import { ReviewRow } from "@/components/review/ReviewRow";
import { useRepos } from "@/hooks/useRepos";
import { useRepoStatus } from "@/hooks/useRepoStatus";
import { useDisconnectRepo, useTriggerIndex } from "@/hooks/useRepoMutations";
import { useReviews } from "@/hooks/useReviews";
import { normalizeApiError } from "@/lib/errors";
import { formatAbsolute, formatCount, formatRelative } from "@/lib/utils";
import type { RepoOut, RepoStatusOut } from "@/types/api";

type TabId = "overview" | "reviews" | "index";

const TAB_IDS: TabId[] = ["overview", "reviews", "index"];

/** How many recent reviews the Overview shows before pointing at the tab. */
const RECENT = 3;

/**
 * One repository: what Liffy knows about it, and what it has reviewed there.
 *
 * There is no `GET /repos/{id}`, so the repo itself comes out of the list —
 * which the repositories page has usually already cached, making this instant
 * on the common path and one request on a cold deep link.
 */
export function RepoDetail() {
  const { repoId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get("tab");
  const tab: TabId = TAB_IDS.includes(tabParam as TabId)
    ? (tabParam as TabId)
    : "overview";

  const repos = useRepos();
  const repo = repos.data?.find((candidate) => candidate.id === repoId);

  const status = useRepoStatus(repoId, { enabled: Boolean(repo) });
  const reindex = useTriggerIndex();
  const disconnect = useDisconnectRepo();
  const [confirming, setConfirming] = useState(false);

  /**
   * This repository's newest reviews, asked for as such.
   *
   * Until `GET /reviews` took a repo parameter this filtered the global list
   * client-side, which meant a repo whose last review was 25 reviews ago
   * showed an empty list on its own detail page — the rows existed, they were
   * just never on the page that got fetched.
   *
   * `enabled` waits for the repo to resolve out of the list rather than firing
   * a request for a `repoId` that may not be one of the caller's.
   */
  const reviews = useReviews({ limit: 20, repoId }, { enabled: Boolean(repo) });
  const repoReviews = reviews.items;

  function goTo(next: TabId) {
    const params = new URLSearchParams(searchParams);
    if (next === "overview") params.delete("tab");
    else params.set("tab", next);
    setSearchParams(params, { replace: true });
  }

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
          action={<ButtonLink to="/repositories">All repositories</ButtonLink>}
        />
      </Sheet>
    );
  }

  const tabs: TabSpec<TabId>[] = [
    { id: "overview", label: "Overview" },
    {
      id: "reviews",
      label: "Reviews",
      count: reviews.data ? reviews.total : undefined,
    },
    { id: "index", label: "Index" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
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
            {/* Destructive, so it stays quiet and behind a confirm — not a
                red button sitting level with the one you press weekly. */}
            <Button variant="ghost" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {status.data && <IndexBadge value={status.data.status} />}
          <p className="text-sm text-ink-sub" data-numeric>
            <span className="font-code">{repo.default_branch}</span>
            {status.data ? ` · ${formatCount(status.data.chunk_count)} chunks` : ""}
            {" · connected "}
            <time
              dateTime={repo.created_at}
              title={formatAbsolute(repo.created_at)}
            >
              {formatRelative(repo.created_at)}
            </time>
          </p>
        </div>

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

      <Tabs tabs={tabs} active={tab} onChange={goTo} idPrefix="repo" />

      <TabPanel id="overview" active={tab} idPrefix="repo">
        <div className="flex flex-col gap-6">
          <IndexFacts repo={repo} status={status.data} pending={status.isPending} />

          <Sheet aria-label="Recent reviews">
            <Sheet.Header
              title="Recent reviews"
              count={reviews.data ? reviews.total : undefined}
              actions={
                repoReviews.length > RECENT ? (
                  <button
                    type="button"
                    onClick={() => goTo("reviews")}
                    className="text-sm text-ink-dim hover:text-ink"
                  >
                    View all →
                  </button>
                ) : undefined
              }
            />
            <ReviewList
              reviews={reviews}
              rows={repoReviews.slice(0, RECENT)}
              repo={repo}
            />
          </Sheet>
        </div>
      </TabPanel>

      <TabPanel id="reviews" active={tab} idPrefix="repo">
        <Sheet aria-label="Reviews">
          <Sheet.Header
            title="Reviews"
            count={reviews.data ? reviews.total : undefined}
          />
          <ReviewList reviews={reviews} rows={repoReviews} repo={repo} showAllLink />
        </Sheet>
      </TabPanel>

      <TabPanel id="index" active={tab} idPrefix="repo">
        <div className="flex flex-col gap-6">
          <Sheet aria-label="Index status">
            <Sheet.Header title="Status" />
            <Sheet.Body className="flex flex-col gap-4">
              <IndexStatus
                status={status.data}
                isPending={status.isPending}
                fallbackIndexedAt={repo.indexed_at}
              />
              <div>
                <Button
                  onClick={() => reindex.mutate(repo.id)}
                  loading={reindex.isPending}
                >
                  Re-index repository
                </Button>
              </div>
            </Sheet.Body>
          </Sheet>

          <IndexFacts repo={repo} status={status.data} pending={status.isPending} />
        </div>
      </TabPanel>

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
                    onSuccess: () => navigate("/repositories"),
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

/**
 * What Liffy actually knows about this repository's index.
 *
 * Embedding provider and model are deliberately absent: they are global
 * configuration, they are not on any repository endpoint, and the brief puts
 * them in Settings → Infrastructure. This describes *this* index.
 */
function IndexFacts({
  repo,
  status,
  pending,
}: {
  repo: RepoOut;
  status: RepoStatusOut | undefined;
  pending: boolean;
}) {
  const indexedAt = status?.indexed_at ?? repo.indexed_at;
  const skipped = status?.last_index_failed_files;
  const seen = status?.last_indexed_files_seen;

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Branch", value: <span className="font-code">{repo.default_branch}</span> },
    {
      label: "Chunks",
      value: status ? formatCount(status.chunk_count) : pending ? "…" : "—",
    },
    {
      label: "Last indexed",
      value: indexedAt ? (
        <time dateTime={indexedAt} title={formatAbsolute(indexedAt)}>
          {formatRelative(indexedAt)}
        </time>
      ) : (
        "Never"
      ),
    },
  ];

  // Only when it was actually measured. `null` means "never recorded", which
  // is not the same fact as "nothing was skipped" — and only the latter earns
  // a clean answer.
  if (skipped !== null && skipped !== undefined) {
    rows.push({
      label: "Files skipped",
      value:
        skipped === 0 ? (
          "None"
        ) : (
          <span className="text-ochre">
            {formatCount(skipped)}
            {seen ? ` of ${formatCount(seen)}` : ""} — those files have no
            context
          </span>
        ),
    });
  }

  return (
    <Sheet aria-label="Index">
      <Sheet.Header title="Index" />
      <Sheet.List>
        {rows.map((row) => (
          <Sheet.Row key={row.label}>
            <span className="label w-32 shrink-0">{row.label}</span>
            <span className="min-w-0 text-base text-ink" data-numeric>
              {row.value}
            </span>
          </Sheet.Row>
        ))}
      </Sheet.List>
    </Sheet>
  );
}

function ReviewList({
  reviews,
  rows,
  repo,
  showAllLink = false,
}: {
  reviews: ReturnType<typeof useReviews>;
  rows: ReturnType<typeof useReviews>["items"];
  repo: RepoOut;
  showAllLink?: boolean;
}) {
  if (reviews.isPending) return <SkeletonRows rows={3} />;

  if (reviews.isError) {
    return (
      <Sheet.Body>
        <ErrorNote error={reviews.error} onRetry={() => reviews.refetch()} />
      </Sheet.Body>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing reviewed here yet."
        description="Open a pull request against this repository, or trigger a review by hand."
        action={<ButtonLink to="/reviews">All reviews</ButtonLink>}
      />
    );
  }

  return (
    <>
      <Sheet.List as="ul" aria-label={`Reviews for ${repo.full_name}`}>
        {rows.map((review) => (
          <ReviewRow key={review.id} review={review} detailed />
        ))}
      </Sheet.List>
      {showAllLink && reviews.total > rows.length && (
        <Sheet.Footer>
          <p className="text-sm text-ink-dim">
            The {rows.length} most recent of {reviews.total}. See{" "}
            <Link to={`/reviews?repo=${repo.id}`} className="underline">
              all reviews for this repository
            </Link>
            .
          </p>
        </Sheet.Footer>
      )}
    </>
  );
}

function RepoSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-72" />
        <Skeleton className="w-48" />
      </div>
      <Sheet>
        <Sheet.Header title="Index" />
        <SkeletonRows rows={3} />
      </Sheet>
    </div>
  );
}
