import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { useCommentFeedback } from "@/hooks/useCommentFeedback";
import { cn } from "@/lib/utils";
import type { ReviewCommentOut } from "@/types/api";

/**
 * Was this comment worth making? The answer is the only input report §8.1's
 * approval rate has — nothing else in the app writes `comment_feedback`.
 *
 * Two toggles rather than one three-state control: "helpful" and "not
 * helpful" are separate claims, and a single button cycling through
 * up → down → unset would make the current state a thing you deduce from the
 * last click rather than read.
 *
 * `aria-pressed` rather than swapping the label to "Rated helpful" — the
 * control is one toggle in two states, so the name stays put while the state
 * changes under it. Same reasoning as ThemeToggle.
 */
export function CommentRating({
  comment,
  reviewId,
}: {
  comment: ReviewCommentOut;
  reviewId: string;
}) {
  const feedback = useCommentFeedback(reviewId);

  function rate(next: 1 | -1) {
    // Both guards are here rather than on the buttons because the buttons are
    // only `aria-disabled` — see RatingButton for why they stay clickable.
    if (feedback.isPending) return;
    // Clicking the side that is already chosen does nothing. The API would
    // happily accept it — re-rating replaces — but it is a write that cannot
    // change anything, and it would flash the busy state for no reason.
    if (comment.my_rating === next) return;
    feedback.mutate({ commentId: comment.id, rating: next });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-1">
        <RatingButton
          pressed={comment.my_rating === 1}
          onClick={() => rate(1)}
          busy={feedback.isPending}
          label="Helpful"
          tone="sage"
        />
        <RatingButton
          pressed={comment.my_rating === -1}
          onClick={() => rate(-1)}
          busy={feedback.isPending}
          label="Not helpful"
          tone="oxide"
          down
        />
      </div>

      {feedback.isError && (
        <ErrorNote
          error={feedback.error}
          // Overridden because `normalizeApiError` reads `detail` only when
          // it is a string, and FastAPI's validation 422 sends an array — so
          // the shared mapper falls through to *"That doesn't look like
          // owner/name."*, which is nonsense on a thumbs-up. Fixed here
          // rather than in the mapper, which every other page depends on.
          message="Couldn't save that rating."
          onRetry={() => {
            // The rollback already put the thumb back, so re-firing the same
            // variables is a real retry rather than a resend of whatever the
            // control happens to show now.
            const last = feedback.variables;
            if (last) feedback.mutate(last);
          }}
          className="w-full"
        />
      )}
    </div>
  );
}

/**
 * The two buttons differ only in glyph direction and pressed tint.
 *
 * `aria-disabled` rather than `disabled` while a rating is in flight.
 * A truly disabled button drops focus to `<body>`, so rating with the
 * keyboard would throw the user back to the top of the page — eight times on
 * the fixture review. This keeps focus where it was and puts the no-op in the
 * click handler instead; Button already styles the attribute.
 */
function RatingButton({
  pressed,
  onClick,
  busy,
  label,
  tone,
  down,
}: {
  pressed: boolean;
  onClick: () => void;
  busy: boolean;
  label: string;
  tone: "sage" | "oxide";
  down?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-disabled={busy}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      className={cn(
        // `ink-dim` (5.2:1), never `ink-sub` — index.css marks that one LARGE
        // TEXT AND NON-TEXT ONLY at 3.2:1, and this is a 16px glyph.
        "px-1.5 text-ink-dim",
        pressed && PRESSED[tone],
      )}
    >
      <ThumbIcon filled={pressed} down={down} />
    </Button>
  );
}

/**
 * Hover is restated on the pressed variants because Button's ghost skin sets
 * its own, and a pressed thumb that turns grey under the cursor reads as
 * having been un-rated.
 */
const PRESSED: Record<"sage" | "oxide", string> = {
  sage: "border-sage/40 bg-sage-tint text-sage hover:border-sage hover:text-sage",
  oxide:
    "border-oxide/40 bg-oxide-tint text-oxide hover:border-oxide hover:text-oxide",
};

/**
 * Thumb up, or point-reflected for down — which is what the convention
 * actually is, cuff and all, not a vertical mirror.
 *
 * The pressed state fills the glyph as well as tinting it. Colour alone would
 * fail anyone who cannot separate `--sage` from `--oxide`, and both tints are
 * quiet by design; outline-versus-solid survives greyscale.
 */
function ThumbIcon({ filled, down }: { filled: boolean; down?: boolean }) {
  const fill = filled ? "currentColor" : "none";

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cn("size-4", down && "rotate-180")}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
    >
      {/* Cuff and hand stay two shapes so the fold between them is still
          legible once both are filled. */}
      <path d="M1.9 7.6h2.9v6.5H1.9z" fill={fill} />
      <path
        d="M4.8 7.7 7.9 2.2a1.9 1.9 0 0 1 2.1 2.4l-.6 2h3.2a1.6 1.6 0 0 1 1.55 2l-1.05 3.9a1.9 1.9 0 0 1-1.85 1.6H4.8z"
        fill={fill}
      />
    </svg>
  );
}
