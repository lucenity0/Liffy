import { Suspense, lazy, useMemo } from "react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { FileTree } from "@/components/review/FileTree";
import { ReviewComment } from "@/components/review/ReviewComment";
import type { FileDiff } from "@/lib/diff";
import { commentCounts, fileStat } from "@/lib/reviewStats";
import type { ReviewCommentOut } from "@/types/api";

/**
 * The whole Monaco dependency hangs off this one lazy import. Static-importing
 * MonacoDiff anywhere would pull megabytes of editor into the main chunk and
 * make every page pay for a viewer only this one uses.
 */
const MonacoDiff = lazy(() => import("@/components/review/diff/MonacoDiff"));

const STATUS_TONE = {
  added: "sage",
  deleted: "oxide",
  renamed: "payne",
  modified: "neutral",
} as const;

/**
 * The code inspection workspace: a file tree that stays put, and one file's
 * diff at a time.
 *
 * It replaces a single column that rendered *every* file's diff stacked
 * vertically — thousands of pixels for a large PR, with no way to reach a
 * specific file except scrolling past the others. Selecting a file now swaps
 * the right pane and leaves the tree exactly where it was.
 */
export function FilesTab({
  files,
  comments,
  reviewId,
  selectedPath,
  focus,
  onSelectFile,
  onGlyphClick,
}: {
  files: FileDiff[];
  comments: ReviewCommentOut[];
  reviewId: string;
  selectedPath: string | null;
  focus: { filePath: string; line: number } | null;
  onSelectFile: (path: string) => void;
  onGlyphClick?: (comment: ReviewCommentOut) => void;
}) {
  const counts = useMemo(() => commentCounts(comments), [comments]);
  const paths = useMemo(() => files.map((file) => file.path), [files]);

  // Falls back to the first file so the pane is never empty on arrival, and
  // so a stale `?file=` from a re-review does not render a blank workspace.
  const active =
    files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  const activeComments = useMemo(
    () =>
      active
        ? comments
            .filter((comment) => comment.file_path === active.path)
            .sort((a, b) => a.line_start - b.line_start || a.line_end - b.line_end)
        : [],
    [comments, active],
  );

  if (files.length === 0) {
    return (
      <Sheet>
        <EmptyState
          title="No diff was stored."
          description="This review ran before Liffy kept the diff, or the pull request had no reviewable changes."
        />
      </Sheet>
    );
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* 240–280px per the brief. Sticky so it survives a long diff. */}
      <div className="w-full shrink-0 lg:sticky lg:top-14 lg:max-h-[calc(100dvh-5rem)] lg:w-64">
        <Sheet className="flex max-h-[22rem] flex-col lg:max-h-[calc(100dvh-5rem)]">
          <Sheet.Header title="Changed files" count={files.length} />
          <Sheet.Body className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <FileTree
              paths={paths}
              selected={active?.path ?? null}
              commentCounts={counts}
              onSelect={onSelectFile}
            />
          </Sheet.Body>
        </Sheet>
      </div>

      {/* min-w-0 so a wide diff scrolls inside the editor rather than
          stretching the flex row past the viewport. */}
      {active && (
        <div className="min-w-0 flex-1">
          <FilePane
            file={active}
            comments={activeComments}
            reviewId={reviewId}
            focus={focus?.filePath === active.path ? focus : null}
            onGlyphClick={onGlyphClick}
          />
        </div>
      )}
    </div>
  );
}

function FilePane({
  file,
  comments,
  reviewId,
  focus,
  onGlyphClick,
}: {
  file: FileDiff;
  comments: ReviewCommentOut[];
  reviewId: string;
  focus: { line: number } | null;
  onGlyphClick?: (comment: ReviewCommentOut) => void;
}) {
  const { additions, deletions } = fileStat(file);

  return (
    <Sheet aria-label={`Diff for ${file.path}`}>
      <Sheet.Header className="flex-wrap gap-y-1">
        <span className="min-w-0 flex-1 truncate font-code text-base text-ink" title={file.path}>
          {file.path}
        </span>
        {file.status !== "modified" && (
          <Badge tone={STATUS_TONE[file.status]} variant="outline">
            {file.status}
          </Badge>
        )}
        <span data-numeric className="shrink-0 font-code text-sm">
          <span className="text-sage">+{additions}</span>{" "}
          <span className="text-oxide">−{deletions}</span>
        </span>
      </Sheet.Header>

      {file.isBinary ? (
        <p className="px-4 py-6 text-base text-ink-dim">
          Binary file — nothing to show.
        </p>
      ) : (
        /**
         * The lazy chunk can fail to load long after this route rendered
         * fine (a redeploy invalidating the hashed filename is the usual
         * way), and the router's errorElement does not cover that — hence a
         * boundary right here rather than one around the page.
         */
        <ErrorBoundary
          fallback={(error) => (
            <p className="px-4 py-6 text-base text-ink-dim">
              The diff viewer failed to load: {error.message}
            </p>
          )}
        >
          <Suspense fallback={<EditorSkeleton />}>
            <MonacoDiff
              file={file}
              comments={comments}
              focus={focus}
              onGlyphClick={onGlyphClick}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Inline under the diff, not in a side panel and not a chat: the
          brief is explicit, and a finding belongs next to the code it is
          about. Monaco owns its own scroll box, so these cannot literally
          interleave with the lines — directly beneath, in line order, is as
          close as the editor allows. */}
      {comments.length > 0 && (
        <div className="divide-y divide-rule border-t border-rule">
          {comments.map((comment) => (
            <ReviewComment
              key={comment.id}
              comment={comment}
              reviewId={reviewId}
            />
          ))}
        </div>
      )}
    </Sheet>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-4 py-4" aria-hidden="true">
      <Skeleton className="w-3/4" />
      <Skeleton className="w-1/2" />
      <Skeleton className="w-2/3" />
    </div>
  );
}
