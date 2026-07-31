import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { useReviewEval } from "@/hooks/useReviewEval";
import { formatPercent } from "@/lib/utils";
import type { EvalScoresOut } from "@/types/api";

/**
 * Report §8.1's approval target: **more than** 70%, strictly.
 *
 * Hardcoded here, unlike #200's tiles, which read `target` off the response.
 * `EvalScoresOut` carries no target — it is a raw rate — so a constant is the
 * only option at this call site. Worth knowing that this number and
 * `/analytics/summary`'s can therefore drift apart; if §8.1 ever moves, this
 * is the line that does not move with it.
 */
const APPROVAL_TARGET = 0.7;

/**
 * How this review scored, on the page where the ratings were given.
 *
 * Approval rate only. `false_positive_rate` is in the response but is exactly
 * `1 - approval_rate` — `comment_feedback` records no reason for a
 * thumbs-down, so there is nothing to distinguish "wrong" from "not useful"
 * (ADR 004). Showing both against §8.1's two targets would put a
 * contradiction on screen: 71% approval reads as a pass beside 29% false
 * positives reading as a fail, for the same six clicks.
 */
export function ReviewScores({ reviewId }: { reviewId: string }) {
  const eval_ = useReviewEval(reviewId);

  return (
    <Sheet aria-label="Rating">
      <Sheet.Header title="Rating" />

      {eval_.isPending ? (
        <Sheet.Body className="flex flex-col gap-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="w-40" />
        </Sheet.Body>
      ) : eval_.isError ? (
        // In place of the section, not instead of the page — a score that
        // failed to load must not cost the reader the review itself.
        <Sheet.Body>
          <ErrorNote
            error={eval_.error}
            message="Couldn't load the rating for this review."
            onRetry={() => eval_.refetch()}
          />
        </Sheet.Body>
      ) : (
        <Scores scores={eval_.data} />
      )}
    </Sheet>
  );
}

function Scores({ scores }: { scores: EvalScoresOut }) {
  /**
   * Nothing to rate is not the same as nothing rated. An `approve` verdict
   * with no line comments will never have a score, so it gets a sentence
   * rather than an invitation to go and rate something that is not there.
   */
  if (scores.total_comments === 0) {
    return (
      <EmptyState
        title="Nothing to rate."
        description="Liffy had no line-level comments on this review, so there is no approval rate to compute."
      />
    );
  }

  /**
   * `=== null`, never `?? 0`.
   *
   * `0` is a legitimate value here — it means every rating was negative — and
   * collapsing the two would tell someone their review was rejected when in
   * fact nobody has looked at it. This is the distinction #191 returns `null`
   * to preserve, and the single most likely thing to be undone by a later
   * "tidy-up".
   */
  if (scores.approval_rate === null) {
    return (
      <EmptyState
        title="No ratings yet."
        description={`Rate the ${scores.total_comments} comments below to score this review.`}
      />
    );
  }

  const met = scores.approval_rate > APPROVAL_TARGET;

  return (
    <>
      <Sheet.Body className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="font-hand text-2xl leading-none text-ink" data-numeric>
          {formatPercent(scores.approval_rate)}
        </p>
        {/* Labelled, not just tinted — "Meets target" and "Below target" are
            the claim, and the tone only agrees with it. */}
        <Badge tone={met ? "sage" : "ochre"} size="md">
          {met ? "Meets target" : "Below target"}
        </Badge>
        {/* `ink-dim` (5.2:1). `ink-sub` is marked LARGE TEXT AND NON-TEXT ONLY
            at 3.2:1 in index.css, and this is a 12.5px caption. */}
        <p className="text-sm text-ink-dim">
          {scores.rated_comments} of {scores.total_comments} comments rated
        </p>
      </Sheet.Body>

      <Sheet.Footer>
        <p className="text-sm text-ink-dim">
          Report §8.1 asks for more than 70% approval. There is no separate
          false-positive figure: a thumbs-down records no reason, so that rate
          is exactly the inverse of this one.
        </p>
      </Sheet.Footer>
    </>
  );
}
