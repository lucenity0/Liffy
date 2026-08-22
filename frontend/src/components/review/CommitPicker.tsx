import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { usePrCommits, useReviewCommits } from "@/hooks/usePrCommits";
import { normalizeApiError } from "@/lib/errors";
import { formatRelative } from "@/lib/utils";

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
 *
 * **Only unreviewed commits are listed.** The earlier version kept the
 * reviewed ones, greyed and labelled, so that "new" had something to contrast
 * against. In use that backfired: a panel headed `COMMITS (1)` over twelve
 * rows reads as twelve things to act on, and the header count — the part
 * actually carrying the meaning — was lost among them. The count stays; the
 * rows that existed only for contrast do not.
 */
export function CommitPicker({ prId }: { prId: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const commits = usePrCommits(prId, open);
  const review = useReviewCommits({
    // Cleared on success, because the sheet stays open afterwards and the
    // ticks stayed put. The button remained enabled over the same selection,
    // so a second click queued the *same commits again* — a whole extra review
    // spent on work that was just done. Nothing about that reads as a mistake
    // at the time: the button looks exactly as it did a moment earlier.
    onQueued: () => setSelected(new Set()),
  });

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
        Review new commits
      </Button>
    );
  }

  // Only what has not been reviewed yet.
  //
  // Reviewed commits used to stay in the list, on the reasoning that seeing
  // what was covered is what makes "new" mean anything. That reasoning is
  // sound in the abstract and wrong in practice: a panel headed COMMITS (1)
  // listing twelve rows, eleven of them greyed "reviewed", reads as a list of
  // things to act on. It invites you to tick, and the one control that ignores
  // your ticks is the button directly above it. The count in the header is
  // what makes "new" mean something; the eleven rows were noise that looked
  // like signal.
  const all = commits.data ?? [];
  const rows = all.filter((c) => c.is_new);
  const newCount = rows.length;
  const reviewedCount = all.length - rows.length;

  // The selection, intersected with what is actually on screen.
  //
  // `selected` is a Set that outlives any particular render of `rows`, and
  // since only unreviewed commits are listed the two can describe different
  // worlds: a header reading "Review 2 commits" over a body reading "Nothing
  // new to review". Today they cannot actually diverge — `keys.reviews.commits`
  // sits under `prs` precisely so review invalidation does not refetch it, and
  // `staleTime: Infinity` keeps it put — but that is an invariant owned by two
  // other files, and the picker should not depend on it holding. Deriving the
  // button from what is visible makes the question moot.
  const visible = new Set(rows.map((c) => c.sha));
  const picked = [...selected].filter((sha) => visible.has(sha));

  return (
    <Sheet>
      <Sheet.Header
        title="Commits"
        count={commits.data ? newCount : undefined}
        actions={
          <Button
            onClick={() => review.mutate({ prId, shas: picked })}
            loading={review.isPending}
            disabled={picked.length === 0}
          >
            {picked.length === 0
              ? "Review selected"
              : `Review ${picked.length} commit${picked.length === 1 ? "" : "s"}`}
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
          {/* Two different empty states. "Nothing new" is the common one and
              it is good news — saying "no commits" there would read as the
              picker having failed to load. */}
          <p className="text-base text-ink-dim">
            {reviewedCount > 0
              ? `Nothing new to review — all ${reviewedCount} commit${
                  reviewedCount === 1 ? " has" : "s have"
                } been reviewed. Re-review reads the whole pull request again.`
              : "No commits on this pull request."}
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
