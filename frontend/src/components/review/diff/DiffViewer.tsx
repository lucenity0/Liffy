import { Suspense, lazy, useMemo } from "react";
import { Badge } from "@/components/ui/Badge";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { parseDiff, type FileDiff } from "@/lib/diff";
import type { ReviewCommentOut } from "@/types/api";

/**
 * The whole Monaco dependency hangs off this one lazy import. Static-importing
 * MonacoDiff anywhere would pull megabytes of editor into the main chunk and
 * make every page pay for a viewer only this one uses.
 */
const MonacoDiff = lazy(() => import("./MonacoDiff"));

const STATUS_TONE = {
  added: "sage",
  deleted: "oxide",
  renamed: "payne",
  modified: "neutral",
} as const;

export function DiffViewer({
  rawDiff,
  comments,
  focus,
  onGlyphClick,
}: {
  rawDiff: string;
  comments: ReviewCommentOut[];
  /** Which file and line to reveal. A fresh object per click on a comment. */
  focus?: { filePath: string; line: number } | null;
  onGlyphClick?: (comment: ReviewCommentOut) => void;
}) {
  const files = useMemo(() => parseDiff(rawDiff), [rawDiff]);

  const commentsByFile = useMemo(() => {
    const map = new Map<string, ReviewCommentOut[]>();
    for (const comment of comments) {
      const existing = map.get(comment.file_path);
      if (existing) existing.push(comment);
      else map.set(comment.file_path, [comment]);
    }
    return map;
  }, [comments]);

  if (files.length === 0) return null;

  return (
    <Sheet aria-label="Diff">
      <Sheet.Header title="Diff" count={files.length} />
      {files.map((file) => (
        <FilePanel
          key={file.path}
          file={file}
          comments={commentsByFile.get(file.path) ?? []}
          focus={focus?.filePath === file.path ? focus : null}
          onGlyphClick={onGlyphClick}
        />
      ))}
    </Sheet>
  );
}

function FilePanel({
  file,
  comments,
  focus,
  onGlyphClick,
}: {
  file: FileDiff;
  comments: ReviewCommentOut[];
  focus: { line: number } | null;
  onGlyphClick?: (comment: ReviewCommentOut) => void;
}) {
  // Files Liffy had something to say about open first; the rest start folded,
  // because a 40-file PR of untouched-by-review diffs is not what anyone came
  // to read. A pending focus request forces its file open — a reveal into a
  // collapsed <details> would scroll to nothing.
  const hasComments = comments.length > 0;

  return (
    <details
      open={hasComments || focus !== null}
      className="group border-b border-rule last:border-b-0"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 bg-recessed px-4 py-2.5 hover:bg-rule/40 [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="text-ink-sub transition-transform group-open:rotate-90"
        >
          ›
        </span>
        <span className="font-code text-base break-all text-ink">
          {file.path}
        </span>
        {file.status !== "modified" && (
          <Badge tone={STATUS_TONE[file.status]} variant="outline">
            {file.status}
          </Badge>
        )}
        {hasComments && (
          <span
            data-numeric
            className="rounded-full bg-rule px-1.5 py-px text-2xs text-ink-dim"
          >
            {comments.length}
          </span>
        )}
      </summary>

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
    </details>
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
