import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { formatRelative } from "@/lib/utils";
import type { ReviewDetailOut } from "@/types/api";

/**
 * The two lifecycle states that have no review to show yet.
 *
 * Nothing here has a refresh button, and that is deliberate: useReview polls
 * every 3s while the status is pending or processing and stops the moment it
 * is not, so this panel replaces itself. A refresh button would imply the
 * page is stuck when it is simply waiting.
 */
export function ReviewInFlight({ review }: { review: ReviewDetailOut }) {
  const queued = review.status === "pending";

  return (
    <Sheet>
      <Sheet.Header title={queued ? "Queued" : "Reading"} />
      <Sheet.Body className="flex items-start gap-3 py-8">
        <Spinner size="md" label="" className="mt-1" />
        <div className="flex flex-col gap-1">
          <p className="font-hand text-lg leading-tight text-ink">
            {queued
              ? "Waiting for a worker to pick this up…"
              : "Liffy is reading the diff…"}
          </p>
          <p className="text-sm text-ink-dim">
            {queued
              ? "This page updates itself the moment it starts."
              : "Retrieving context from the index and writing comments. This usually takes under a minute."}
          </p>
        </div>
      </Sheet.Body>
    </Sheet>
  );
}

export function ReviewFailed({ review }: { review: ReviewDetailOut }) {
  return (
    <Sheet className="border-oxide/30">
      <Sheet.Header title="Failed" className="bg-oxide-tint" />
      <Sheet.Body className="flex flex-col gap-2">
        <p className="font-hand text-lg leading-tight text-ink">
          This review did not finish.
        </p>
        <p className="max-w-prose text-base text-ink-dim">
          {/* The API keeps no failure reason on the row — the worker logs it
              and moves on — so pointing at the logs beats inventing a cause. */}
          The worker gave up
          {review.completed_at && ` ${formatRelative(review.completed_at)}`}.
          Common causes are a missing or rate-limited LLM key, or a diff too
          large for the model's context. The worker log has the reason; Re-review
          runs the whole pipeline again.
        </p>
      </Sheet.Body>
    </Sheet>
  );
}
