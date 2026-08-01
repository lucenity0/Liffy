import { useState } from "react";
import { useParams } from "react-router-dom";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { CommentGroup } from "@/components/review/CommentGroup";
import { DiffViewer } from "@/components/review/diff/DiffViewer";
import { ReviewHeader } from "@/components/review/ReviewHeader";
import { ReviewFailed, ReviewInFlight } from "@/components/review/ReviewStates";
import { ReviewScores } from "@/components/review/ReviewScores";
import { ReviewSummary } from "@/components/review/ReviewSummary";
import { useReview } from "@/hooks/useReview";
import { useRereview } from "@/hooks/useReviewMutations";
import type { ReviewCommentOut } from "@/types/api";
import { normalizeApiError } from "@/lib/errors";
import { commentAnchorId, groupCommentsByFile } from "@/lib/reviewUtils";

/**
 * One review, in whichever of its four states it happens to be in.
 *
 * The state machine is the page: pending and processing have nothing to show
 * and are replaced live by useReview's 3s poll; failed has no output at all;
 * only completed reaches the summary and comments.
 */
export function ReviewDetail() {
  const { reviewId } = useParams();
  const review = useReview(reviewId);
  const rereview = useRereview();

  /**
   * Half of the two-way navigation. A fresh object per click is the signal
   * the diff viewer watches, so clicking the same comment twice reveals
   * twice while an unrelated re-render leaves the viewport alone.
   */
  const [focus, setFocus] = useState<{
    filePath: string;
    line: number;
  } | null>(null);

  /** The other half: a glyph in the gutter scrolls back to its card. */
  function revealComment(comment: ReviewCommentOut) {
    document.getElementById(commentAnchorId(comment.id))?.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }

  if (review.isPending) return <DetailSkeleton />;

  if (review.isError) {
    const error = normalizeApiError(review.error);
    if (error.kind === "not_found") {
      return (
        <Sheet>
          <EmptyState
            title="No review filed under that id."
            description="It may have been removed with its repository, or the link may be wrong."
            action={<ButtonLink to="/reviews">All reviews</ButtonLink>}
          />
        </Sheet>
      );
    }
    return <ErrorNote error={review.error} onRetry={() => review.refetch()} />;
  }

  const data = review.data;
  const groups = groupCommentsByFile(data.comments);

  return (
    <div className="flex flex-col gap-6">
      <ReviewHeader
        review={data}
        onRereview={() => rereview.mutate(data.id)}
        rereviewing={rereview.isPending}
        rereviewQueued={rereview.isSuccess}
        rereviewError={rereview.error}
      />

      {(data.status === "pending" || data.status === "processing") && (
        <ReviewInFlight review={data} />
      )}

      {data.status === "failed" && <ReviewFailed review={data} />}

      {data.status === "completed" && (
        <>
          <ReviewSummary review={data} />

          {/* Mounted only in the completed branch, which is the gate: a
              pending or processing review has no comments to rate, so the
              request would be a guaranteed empty answer fired alongside
              useReview's 3s poll. */}
          <ReviewScores reviewId={data.id} />

          {data.raw_diff && (
            <DiffViewer
              rawDiff={data.raw_diff}
              comments={data.comments}
              focus={focus}
              onGlyphClick={revealComment}
            />
          )}

          <Sheet aria-label="Comments">
            <Sheet.Header title="Comments" count={data.comments.length} />
            {groups.length === 0 ? (
              <EmptyState
                title="Nothing to flag."
                description="Liffy read the diff and had no line-level comments."
              />
            ) : (
              groups.map((group) => (
                <CommentGroup
                  key={group.filePath}
                  group={group}
                  reviewId={data.id}
                  onReveal={
                    data.raw_diff
                      ? (comment) =>
                          setFocus({
                            filePath: comment.file_path,
                            line: comment.line_start,
                          })
                      : undefined
                  }
                />
              ))
            )}
          </Sheet>
        </>
      )}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="w-40" />
      </div>
      <Sheet>
        <Sheet.Header title="Summary" />
        <Sheet.Body className="flex flex-col gap-2">
          <Skeleton className="w-full" />
          <Skeleton className="w-full" />
          <Skeleton className="w-2/3" />
        </Sheet.Body>
      </Sheet>
      <Sheet>
        <Sheet.Header title="Comments" />
        <SkeletonRows rows={2} />
      </Sheet>
    </div>
  );
}
