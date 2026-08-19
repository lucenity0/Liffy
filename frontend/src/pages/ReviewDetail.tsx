import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { TabPanel, Tabs, type TabSpec } from "@/components/ui/Tabs";
import { CommitPicker } from "@/components/review/CommitPicker";
import { ReviewHeader } from "@/components/review/ReviewHeader";
import { ReviewFailed } from "@/components/review/ReviewStates";
import { ReviewProgress } from "@/components/review/ReviewProgress";
import { ChangesTab } from "@/components/review/tabs/ChangesTab";
import { CommentsTab } from "@/components/review/tabs/CommentsTab";
import { FilesTab } from "@/components/review/tabs/FilesTab";
import { SummaryTab } from "@/components/review/tabs/SummaryTab";
import { useReview } from "@/hooks/useReview";
import { useRereview } from "@/hooks/useReviewMutations";
import { parseDiff } from "@/lib/diff";
import { normalizeApiError } from "@/lib/errors";
import { totalStat } from "@/lib/reviewStats";
import { commentAnchorId } from "@/lib/reviewUtils";
import { formatCount } from "@/lib/utils";
import type { ReviewCommentOut } from "@/types/api";

type TabId = "summary" | "files" | "comments" | "changes";

const TAB_IDS: TabId[] = ["summary", "files", "comments", "changes"];

function parseTab(raw: string | null): TabId {
  return TAB_IDS.includes(raw as TabId) ? (raw as TabId) : "summary";
}

/**
 * One review, as a workspace rather than a report.
 *
 * The page used to be a single scrolling document — metadata, prose, every
 * file's diff, then every comment — which for a large PR ran to thousands of
 * pixels and made "find the file Liffy complained about" a scrolling problem.
 * Four tabs split it by the question being asked: what does Liffy think, show
 * me the code, show me everything it flagged, and what moved where.
 *
 * The active tab and file live in the URL. That is what lets a comment in the
 * Comments tab link into the Files tab at the right file and line, and what
 * makes a shared link land where the sender was looking.
 */
export function ReviewDetail() {
  const { reviewId } = useParams();
  const review = useReview(reviewId);
  const rereview = useRereview();
  const [searchParams, setSearchParams] = useSearchParams();

  const tab = parseTab(searchParams.get("tab"));
  const selectedPath = searchParams.get("file");

  /**
   * Half of the two-way navigation. A fresh object per click is the signal
   * the diff viewer watches, so clicking the same comment twice reveals
   * twice while an unrelated re-render leaves the viewport alone.
   */
  const [focus, setFocus] = useState<{
    filePath: string;
    line: number;
  } | null>(null);

  function go(next: Partial<{ tab: TabId; file: string }>) {
    const params = new URLSearchParams(searchParams);
    if (next.tab) {
      // The default tab drops out of the URL rather than being written.
      if (next.tab === "summary") params.delete("tab");
      else params.set("tab", next.tab);
    }
    if (next.file) params.set("file", next.file);
    setSearchParams(params, { replace: true });
  }

  /** The Comments → Files handoff the brief calls out as important. */
  function viewInDiff(comment: ReviewCommentOut) {
    go({ tab: "files", file: comment.file_path });
    setFocus({ filePath: comment.file_path, line: comment.line_start });
  }

  /** The other half: a glyph in the gutter scrolls back to its card. */
  function revealComment(comment: ReviewCommentOut) {
    document.getElementById(commentAnchorId(comment.id))?.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }

  const data = review.data;

  // Hoisted rather than reached through `data?.` inside the memo: the React
  // Compiler cannot prove an optional-chained dependency is narrower than the
  // whole object, and refuses to optimize the component when it disagrees.
  const rawDiff = data?.raw_diff ?? null;
  const files = useMemo(() => (rawDiff ? parseDiff(rawDiff) : []), [rawDiff]);

  const stat = useMemo(() => totalStat(files), [files]);

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

  if (!data) return <DetailSkeleton />;

  const headerMeta = [
    data.model_used,
    data.tokens_used !== null ? `${formatCount(data.tokens_used)} tokens` : null,
    files.length > 0
      ? `${stat.files} file${stat.files === 1 ? "" : "s"} · +${stat.additions} −${stat.deletions}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const tabs: TabSpec<TabId>[] = [
    { id: "summary", label: "Summary" },
    { id: "files", label: "Files", count: files.length },
    { id: "comments", label: "Comments", count: data.comments.length },
    { id: "changes", label: "Changes" },
  ];

  const completed = data.status === "completed";

  return (
    <div className="flex flex-col gap-6">
      <ReviewHeader
        review={data}
        meta={headerMeta}
        onRereview={() => rereview.mutate(data.id)}
        rereviewing={rereview.isPending}
        rereviewQueued={rereview.isSuccess}
        rereviewError={rereview.error}
      />

      {/* Under the header, above the tabs: it is an action on the pull
          request rather than part of reading this review, and it collapses to
          a single button until asked. */}
      <CommitPicker prId={data.pr_id} />

      {(data.status === "pending" || data.status === "processing") && (
        <ReviewProgress review={data} />
      )}

      {data.status === "failed" && <ReviewFailed review={data} />}

      {/* Tabs only once there is something in them. A failed review has no
          summary, no comments and no diff — offering four tabs over an empty
          workspace would pretend otherwise. */}
      {completed && (
        <>
          <Tabs
            tabs={tabs}
            active={tab}
            onChange={(next) => go({ tab: next })}
            idPrefix="review"
          />

          <TabPanel id="summary" active={tab} idPrefix="review">
            <SummaryTab review={data} />
          </TabPanel>

          <TabPanel id="files" active={tab} idPrefix="review">
            <FilesTab
              files={files}
              comments={data.comments}
              reviewId={data.id}
              selectedPath={selectedPath}
              focus={focus}
              onSelectFile={(path) => go({ file: path })}
              onGlyphClick={revealComment}
            />
          </TabPanel>

          <TabPanel id="comments" active={tab} idPrefix="review">
            <CommentsTab
              comments={data.comments}
              reviewId={data.id}
              hasDiff={files.length > 0}
              onViewInDiff={viewInDiff}
            />
          </TabPanel>

          <TabPanel id="changes" active={tab} idPrefix="review">
            <ChangesTab
              described={data.summary_detail?.files ?? []}
              files={files}
            />
          </TabPanel>
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
        <Sheet.Header title="Review summary" />
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
