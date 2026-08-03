import { Link } from "react-router-dom";
import { Sheet } from "@/components/ui/Sheet";
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
export function ReviewFailed({ review }: { review: ReviewDetailOut }) {
  /**
   * The worker writes the reason onto the row now, so show it.
   *
   * This used to be a paragraph of plausible causes — "a missing or
   * rate-limited LLM key, or a diff too large" — because at the time the row
   * genuinely carried nothing. Once it did, the guesses stayed and buried the
   * fact. A real failure read `'claude' is not on PATH`, which is neither of
   * the causes listed and is fixed in one step, while the page sent the user
   * to `docker compose logs` to find that out.
   *
   * The stored value is prefixed, because it is also what the list renders as
   * a one-line summary. It reads better here without it.
   */
  const reason = review.summary?.replace(/^Review failed:\s*/i, "").trim();

  return (
    <Sheet className="border-oxide/30">
      <Sheet.Header title="Failed" className="bg-oxide-tint" />
      <Sheet.Body className="flex flex-col gap-2">
        <p className="font-hand text-lg leading-tight text-ink">
          This review did not finish.
        </p>
        {reason ? (
          <>
            <p className="max-w-prose whitespace-pre-wrap break-words text-base text-ink">
              {reason}
            </p>
            {/* The reason is the best search anyone could type, and they are
                already holding it. Sending the text straight to /help turns a
                dead end into one click — this is the payoff for /help being a
                page with a URL rather than a modal. */}
            <Link
              to={`/help?q=${encodeURIComponent(reason.slice(0, 120))}`}
              className="w-fit text-sm text-ink-dim underline decoration-rule underline-offset-4 hover:text-ink"
            >
              What does this mean? →
            </Link>
          </>
        ) : null}
        <p className="max-w-prose text-base text-ink-dim">
          The worker gave up
          {review.completed_at && ` ${formatRelative(review.completed_at)}`}.
          {reason
            ? " Re-review runs the whole pipeline again."
            : " The worker log has the reason; Re-review runs the whole pipeline again."}
        </p>
      </Sheet.Body>
    </Sheet>
  );
}
