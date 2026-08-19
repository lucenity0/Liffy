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

  // What the reader can do about it. An unrecognised kind — and every review
  // that failed before this column existed — falls through to `undefined`,
  // which is the same as `unknown`: offer to report it rather than invent
  // advice that sends someone to check a setting that is fine.
  const guidance = review.failure_kind
    ? FIXES[review.failure_kind]
    : undefined;
  const detail = review.failure_detail?.trim();

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

        {guidance ? (
          <p className="max-w-prose text-base text-ink-dim">{guidance}</p>
        ) : (
          // No guidance means no *honest* guidance. Say so, and hand over the
          // one action that still helps: telling somebody. The report carries
          // the detail below, so it does not depend on the reporter knowing
          // which parts of it matter.
          <p className="max-w-prose text-base text-ink-dim">
            Nothing here points at a setting you can change.{" "}
            <Link
              to={`/help?report=${encodeURIComponent(reportTitle(review))}`}
              className="underline decoration-rule underline-offset-4 hover:text-ink"
            >
              Report this
            </Link>{" "}
            and the log below goes with it.
          </p>
        )}

        {/* Collapsed, always. The sentence above is the answer for almost
            everyone; this is for the person who needs to paste it somewhere.
            It used to be appended to the message itself, which put three
            hundred characters of truncated JSON in front of every reader and
            still cut it off mid-object. */}
        {detail ? (
          <details className="group mt-1">
            <summary className="w-fit cursor-pointer list-none text-sm text-ink-dim underline decoration-rule underline-offset-4 hover:text-ink">
              View log
              <span className="ml-1 inline-block group-open:hidden">→</span>
              <span className="ml-1 hidden group-open:inline-block">↓</span>
            </summary>
            <pre className="rounded-chip mt-2 max-h-80 overflow-auto border border-rule bg-recessed px-3 py-2">
              <code className="font-code text-sm break-words whitespace-pre-wrap text-ink-sub">
                {detail}
              </code>
            </pre>
          </details>
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

/**
 * What to do about each kind of failure, in the reader's terms.
 *
 * Deliberately not exhaustive over `FailureKind`: an unlisted kind gets the
 * report path, which is the right answer for anything we cannot advise on and
 * the *only* honest one for a kind added after this map was written.
 */
const FIXES: Record<string, string> = {
  limit:
    "Nothing is misconfigured and nothing needs changing — the allowance resets on its own, and Re-review will work once it has.",
  auth: "Sign the CLI in on the host, then Re-review. Liffy never stores those credentials itself.",
  cli_missing:
    "Install the provider's CLI on the machine running the worker, or pick a different provider in Settings → Providers.",
  infra:
    "Something Liffy depends on was unreachable. Check the stack is up, then Re-review.",
};

/** A report title that says which review, so it does not need retyping. */
function reportTitle(review: ReviewDetailOut): string {
  return `Review failed on ${review.repo_full_name} #${review.pr_number}`;
}
