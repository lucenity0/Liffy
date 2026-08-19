import { useMemo } from "react";
import { CafeScene } from "@/components/ui/CafeScene";
import { Sheet } from "@/components/ui/Sheet";
import { useSettings } from "@/hooks/useSettings";
import { parseDiff } from "@/lib/diff";
import { formatRelative } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { ReviewDetailOut } from "@/types/api";

type StepState = "done" | "active" | "waiting" | "skipped";

const STATE_LABEL: Record<StepState, string> = {
  done: "complete",
  active: "running",
  waiting: "waiting",
  skipped: "skipped",
};

/**
 * What Liffy is doing, in the landing page's worker-log voice.
 *
 * This replaces a spinner and the words "Liffy is reading the diff…", which
 * told you nothing for the several minutes a real review takes — long enough
 * that people reasonably concluded it had hung.
 *
 * **Every state here is derived from something the API actually proves.** The
 * pipeline in `review_service.py` fetches the diff *before* it inserts the
 * row, so a review that exists at all with `processing` has provably finished
 * fetching, and `raw_diff` is already populated — which is where the file
 * count comes from. Everything after that (retrieval, the model call, the
 * summary, the token count) lands in a single commit at the end, so there is
 * no signal that separates retrieval from review, and this does not invent
 * one: both are shown as in progress and the caption says why.
 */
export function ReviewProgress({ review }: { review: ReviewDetailOut }) {
  const queued = review.status === "pending";

  // Whether the finished review will be posted back. Real configuration, not
  // a guess — and worth saying now rather than after the wait, because "why
  // did nothing appear on my PR" is answered here.
  const settings = useSettings();
  const posts = settings.data?.editable.find(
    (setting) => setting.key === "post_reviews_to_github",
  );
  const willPost = posts ? String(posts.value) === "true" : undefined;

  const fileCount = useMemo(
    () => (review.raw_diff ? parseDiff(review.raw_diff).length : null),
    [review.raw_diff],
  );

  const steps: {
    id: string;
    label: string;
    state: StepState;
    note?: string;
  }[] = [
    {
      id: "fetch",
      label: "Fetch",
      // Provable: the row does not exist until the diff has been fetched.
      state: queued ? "waiting" : "done",
      note:
        !queued && fileCount !== null
          ? `${fileCount} changed file${fileCount === 1 ? "" : "s"}`
          : undefined,
    },
    {
      id: "retrieve",
      label: "Retrieve",
      state: queued ? "waiting" : "active",
      note: "repository context",
    },
    {
      id: "review",
      label: "Review",
      state: queued ? "waiting" : "active",
      // model_used is only written on completion, so there is nothing to name
      // here yet — saying which model is running would be a guess.
      note: undefined,
    },
    {
      id: "post",
      label: "Post",
      state: willPost === false ? "skipped" : "waiting",
      note:
        willPost === false
          ? "posting to GitHub is off"
          : willPost === true
            ? "back to the pull request"
            : undefined,
    },
  ];

  return (
    <Sheet aria-label="Review progress">
      <Sheet.Header title={queued ? "Queued" : "Reviewing"} />
      <Sheet.Body className="flex flex-col gap-4 md:flex-row md:items-start md:gap-8">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <ol className="flex flex-col gap-1.5 font-code text-sm">
            {steps.map((step, index) => (
              <li key={step.id} className="flex items-baseline gap-3">
                <span data-numeric className="w-6 shrink-0 text-ink-sub">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span
                  className={cn(
                    "w-24 shrink-0 uppercase",
                    step.state === "waiting" || step.state === "skipped"
                      ? "text-ink-sub"
                      : "text-ink",
                  )}
                >
                  {step.label}
                </span>
                <span
                  className={cn(
                    "w-24 shrink-0",
                    step.state === "done" && "text-sage",
                    step.state === "active" && "text-ochre",
                    (step.state === "waiting" || step.state === "skipped") &&
                      "text-ink-sub",
                  )}
                >
                  {/* motion-safe, and the codebase's reduced-motion backstop
                    stops the pulse outright for anyone who asked. */}
                  {step.state === "active" && (
                    <span
                      aria-hidden="true"
                      className="mr-1.5 inline-block size-1.5 rounded-full bg-ochre motion-safe:animate-pulse"
                    />
                  )}
                  {STATE_LABEL[step.state]}
                </span>
                {step.note && (
                  <span className="min-w-0 truncate text-ink-dim">
                    {step.note}
                  </span>
                )}
              </li>
            ))}
          </ol>

          <p className="max-w-prose text-sm text-ink-dim">
            {queued ? (
              "Waiting for a worker to pick this up. This page updates itself the moment it starts."
            ) : (
              <>
                {/* No "under a minute" here. That number came from the §8.1
                  target, measured on the API providers; the subscription
                  providers drive a local CLI and take several minutes on a
                  real pull request. Promising a minute turned a healthy
                  six-minute review into "this is broken". */}
                {`Started ${formatRelative(review.created_at)}. A large diff takes a few minutes — longer on the subscription providers, which run the model through a local CLI. `}
                <span className="text-ink-sub">
                  Retrieval and review are reported together: the worker records
                  one status for both.
                </span>
              </>
            )}
          </p>
        </div>

        {/* The half of this panel that used to be empty.

            The scene rather than a still: a review takes minutes, and minutes
            of a static panel is what made people conclude it had hung. The
            monitor beside the cat is lit and its screen scrolls, which is the
            only thing here that moves.

            Those lines are abstract on purpose. A review is one model call, so
            nothing knows which file the model has in front of it — a screen
            naming real files as they scrolled would be inventing telemetry on
            a panel whose stated rule is that every state is derived from
            something the API proves. The step list beside it says what is
            actually known; this says only "something is being read", which is
            true.

            `md:` only. It keeps `CafeScene`'s own `role="img"` and label
            rather than being hidden — that is what every other use of the
            scene does, and a reader who reaches it should be told there is a
            picture rather than finding a gap. It is not announced on its own:
            nothing here is live, so it is read when navigated to and not
            while waiting. */}
        {!queued && (
          <CafeScene
            reading
            className="hidden w-full shrink-0 md:block md:max-w-sm"
          />
        )}
      </Sheet.Body>
    </Sheet>
  );
}
