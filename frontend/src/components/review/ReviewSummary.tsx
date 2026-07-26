import { Sheet } from "@/components/ui/Sheet";
import { formatCount, formatDuration } from "@/lib/utils";
import type { ReviewDetailOut } from "@/types/api";

/**
 * Liffy's verdict in prose — the one block on the page set in Radon at the
 * ruled line-height, in a 68ch column. Everything else on this screen is
 * data; this is the part a model wrote, and it reads as marginalia.
 */
export function ReviewSummary({ review }: { review: ReviewDetailOut }) {
  const meta = [
    review.model_used,
    review.tokens_used !== null
      ? `${formatCount(review.tokens_used)} tokens`
      : null,
    review.completed_at
      ? formatDuration(review.created_at, review.completed_at)
      : null,
  ].filter(Boolean);

  return (
    <Sheet>
      <Sheet.Header title="Summary" />
      <Sheet.Body>
        {review.summary ? (
          <p className="prose-hand">{review.summary}</p>
        ) : (
          <p className="text-base text-ink-dim">
            This review finished without a summary.
          </p>
        )}
      </Sheet.Body>

      {meta.length > 0 && (
        <Sheet.Footer>
          {/* Not the `label` utility: it uppercases, and a model name is a
              proper noun — "GPT-4O" is simply wrong. */}
          <p className="text-sm text-ink-dim" data-numeric>
            {meta.join(" · ")}
          </p>
        </Sheet.Footer>
      )}
    </Sheet>
  );
}
