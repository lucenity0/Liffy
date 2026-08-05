import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { StatusBadge, VerdictBadge } from "@/components/ui/badgeMaps";
import { normalizeApiError } from "@/lib/errors";
import { formatAbsolute, formatRelative } from "@/lib/utils";
import type { ReviewDetailOut } from "@/types/api";

/**
 * Identity and actions. Presentational — the re-review mutation lives on the
 * page, so this stays cheap to render and easy to test.
 */
export function ReviewHeader({
  review,
  meta,
  onRereview,
  rereviewing = false,
  rereviewQueued = false,
  rereviewError,
}: {
  review: ReviewDetailOut;
  /** Model, tokens, file counts — whatever the page has worked out. */
  meta?: string;
  onRereview: () => void;
  rereviewing?: boolean;
  rereviewQueued?: boolean;
  rereviewError?: unknown;
}) {
  const inFlight = review.status === "pending" || review.status === "processing";

  return (
    <header data-liffy="review-header" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h1 className="font-code text-xl leading-tight break-all text-ink">
          {review.repo_full_name}
          <span className="text-ink-sub"> #</span>
          <span data-numeric>{review.pr_number}</span>
        </h1>

        <Button
          onClick={onRereview}
          loading={rereviewing}
          disabled={inFlight}
          className="ml-auto"
        >
          Re-review
        </Button>
      </div>

      {/* No summary line here. The brief's header carries a short blurb
          above a longer OVERVIEW in the Summary tab, but the API has exactly
          one `summary` field — so a header line would be the same sentence
          the default tab already renders in full, two elements apart. One
          copy, in the tab whose job it is.

          Status, verdict and metadata on one line. The badges stay the
          existing size rather than growing into hero indicators; the repo
          and PR above must remain the strongest thing here. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusBadge value={review.status} />
        {review.verdict && <VerdictBadge value={review.verdict} />}
        <p className="text-sm text-ink-sub" data-numeric>
          {meta ? `${meta} · ` : ""}
          <time
            dateTime={review.created_at}
            title={formatAbsolute(review.created_at)}
          >
            {formatRelative(review.created_at)}
          </time>
        </p>
      </div>

      {rereviewError ? (
        <p role="status" className="text-base text-oxide">
          {normalizeApiError(rereviewError).message}
        </p>
      ) : null}

      {rereviewQueued && !rereviewError && (
        /**
         * POST /reviews/{id}/trigger creates a *new* review row rather than
         * resetting this one, so this page will never change state on its
         * own. Saying "queued" and pointing at the list is the only honest
         * thing to do — the alternative is a page that looks frozen.
         */
        <p role="status" className="text-base text-sage">
          {"Re-review queued. It lands as a new review — "}
          <Link to="/reviews" className="underline underline-offset-4">
            see all reviews
          </Link>
          {"."}
        </p>
      )}
    </header>
  );
}
