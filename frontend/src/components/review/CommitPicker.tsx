import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { usePrCommits, useReviewCommits } from "@/hooks/usePrCommits";
import { normalizeApiError } from "@/lib/errors";
import { formatRelative } from "@/lib/utils";

/**
 * Pick which commits are worth reviewing again.
 *
 * A re-review reads the whole pull request, which on a large one is most of
 * the cost and nearly none of the value: the model's finding count barely
 * moves with diff size, so reviewing 100 files to look at 3 spends the budget
 * on the 97 nobody asked about. This asks instead.
 *
 * **The selection picks files, not hunks.** Whatever the chosen commits
 * touched is reviewed *as it stands at the head of the pull request* — so
 * skipping a commit in the middle cannot produce a stale line number, and a
 * file touched by both a chosen and an unchosen commit is read whole.
 *
 * Nothing is fetched until asked. This costs a GitHub call, and most visits
 * to a review are to read it rather than to queue another one.
 */
/**
 * `normalizeApiError`'s shared copy is written around the repo endpoints — its
 * 502 branch says "GitHub couldn't find that repository (is it private?)",
 * which is nonsense when a commit listing fails, and it drops the detail the
 * server sent. Same reason `ReportProblem` phrases its own.
 */
function commitsError(error: unknown): string {
  const normalized = normalizeApiError(error);
  if (normalized.status === 502) {
    return normalized.detail
      ? `GitHub would not list the commits. ${normalized.detail}`
      : "GitHub would not list the commits.";
  }
  return normalized.message;
}

export function CommitPicker({ prId }: { prId: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const commits = usePrCommits(prId, open);
  const review = useReviewCommits();

  function toggle(sha: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  }

  // `w-fit` on the button: this sits in a `flex flex-col` on the review page,
  // where the default `align-items: stretch` pulls a lone button across the
  // whole column.
  if (!open) {
    return (
      <Button variant="ghost" className="w-fit" onClick={() => setOpen(true)}>
        Fetch new commits
      </Button>
    );
  }

  const rows = commits.data ?? [];
  const newCount = rows.filter((c) => c.is_new).length;

  return (
    <Sheet>
      <Sheet.Header
        title="Commits"
        count={commits.data ? newCount : undefined}
        actions={
          <Button
            onClick={() =>
              review.mutate({ prId, shas: [...selected] })
            }
            loading={review.isPending}
            disabled={selected.size === 0}
          >
            {selected.size === 0
              ? "Review selected"
              : `Review ${selected.size} commit${selected.size === 1 ? "" : "s"}`}
          </Button>
        }
      />

      {commits.isPending && <SkeletonRows rows={3} />}

      {commits.isError && (
        <Sheet.Body>
          <ErrorNote
            error={commits.error}
            message={commitsError(commits.error)}
            onRetry={() => commits.refetch()}
          />
        </Sheet.Body>
      )}

      {commits.data && rows.length === 0 && (
        <Sheet.Body>
          <p className="text-base text-ink-dim">
            No commits on this pull request.
          </p>
        </Sheet.Body>
      )}

      {rows.length > 0 && (
        <Sheet.List as="ul" aria-label="Commits">
          {rows.map((commit) => (
            <li key={commit.sha}>
              <label className="flex cursor-pointer items-baseline gap-3 px-4 py-2.5 select-none">
                <input
                  type="checkbox"
                  checked={selected.has(commit.sha)}
                  onChange={() => toggle(commit.sha)}
                  className="size-3.5 shrink-0 accent-sage"
                  aria-label={commit.message || commit.sha}
                />
                <span
                  className="shrink-0 font-code text-sm text-ink-sub"
                  data-numeric
                >
                  {commit.sha.slice(0, 7)}
                </span>
                <span className="min-w-0 flex-1 truncate text-base text-ink">
                  {commit.message || "(no message)"}
                </span>
                {/* Already-reviewed commits stay in the list rather than being
                    filtered out: seeing what was covered is what makes "new"
                    mean anything, and a list that silently drops half a pull
                    request's history invites asking where it went. */}
                {!commit.is_new && (
                  <span className="shrink-0 text-sm text-ink-dim">reviewed</span>
                )}
                <span className="shrink-0 text-sm text-ink-dim">
                  {commit.committed_at ? formatRelative(commit.committed_at) : ""}
                </span>
              </label>
            </li>
          ))}
        </Sheet.List>
      )}

      {review.isSuccess && (
        <Sheet.Footer>
          <p className="text-sm text-sage" role="status">
            Queued. It lands as a new review.
          </p>
        </Sheet.Footer>
      )}

      {review.isError && (
        <Sheet.Body>
          <ErrorNote error={review.error} message={commitsError(review.error)} />
        </Sheet.Body>
      )}
    </Sheet>
  );
}
