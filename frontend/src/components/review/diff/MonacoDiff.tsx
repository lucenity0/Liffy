import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor/editor/editor.api";
import {
  languageForPath,
  renderFileDiff,
  rowRangeForComment,
  type FileDiff,
} from "@/lib/diff";
import { Spinner } from "@/components/ui/Spinner";
import type { ReviewCommentOut } from "@/types/api";
import { PAPER_THEME, setupMonaco } from "./monacoSetup";

const LINE_HEIGHT = 20;
const MAX_HEIGHT = 560;

/**
 * One file's diff in a read-only Monaco editor.
 *
 * Default-exported and imported only through React.lazy — Monaco is a few
 * megabytes and must never reach the main chunk.
 *
 * Everything the editor needs is precomputed: rows, decorations and the
 * row → file-line map all come out of lib/diff, so the Monaco surface here is
 * one onMount and one decorations effect.
 */
export default function MonacoDiff({
  file,
  comments,
  focus,
  onGlyphClick,
}: {
  file: FileDiff;
  comments: ReviewCommentOut[];
  /**
   * A new-file line to reveal. The *object* is the signal, not the number —
   * the page hands over a fresh one per click, so clicking the same comment
   * twice reveals twice, while an unrelated re-render leaves the viewport
   * where the reader put it.
   */
  focus?: { line: number } | null;
  onGlyphClick?: (comment: ReviewCommentOut) => void;
}) {
  const monacoRef = useRef<typeof import("monaco-editor/editor/editor.api") | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const collectionRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  /**
   * The editor mounts asynchronously, so the decoration effect below runs
   * once against empty refs and — with no prop change to follow — would never
   * run again. This is the re-render that makes it run after onMount.
   */
  const [mounted, setMounted] = useState(false);

  const rendered = useMemo(() => renderFileDiff(file), [file]);

  /** Rows carrying a comment, so the glyph click can find its way back. */
  const commentRows = useMemo(() => {
    const map = new Map<number, ReviewCommentOut>();
    for (const comment of comments) {
      const range = rowRangeForComment(
        rendered,
        comment.line_start,
        comment.line_end,
      );
      if (range) map.set(range.startRow, comment);
    }
    return map;
  }, [comments, rendered]);

  // Read through refs inside the mouse handler: it is registered once, and
  // capturing these directly would pin it to the first render's values.
  // Written in an effect rather than during render — a ref mutated mid-render
  // is torn under concurrent rendering, and the lint rule is right about it.
  const commentRowsRef = useRef(commentRows);
  const onGlyphClickRef = useRef(onGlyphClick);
  useEffect(() => {
    commentRowsRef.current = commentRows;
    onGlyphClickRef.current = onGlyphClick;
  });

  const onMount: OnMount = (editorInstance, monacoInstance) => {
    editorRef.current = editorInstance;
    monacoRef.current = monacoInstance as typeof monacoRef.current;

    editorInstance.onMouseDown((event) => {
      const line = event.target.position?.lineNumber;
      const comment = line ? commentRowsRef.current.get(line) : undefined;
      if (comment) onGlyphClickRef.current?.(comment);
    });

    setMounted(true);
  };

  // One effect, applying decorations from props. Anything cleverer than this
  // and the editor stops being a rendering target and starts being state.
  useEffect(() => {
    const editorInstance = editorRef.current;
    const monacoInstance = monacoRef.current;
    if (!editorInstance || !monacoInstance) return;

    const decorations: editor.IModelDeltaDecoration[] = [];

    rendered.rows.forEach((row, index) => {
      const className =
        row.kind === "added"
          ? "diff-line-added"
          : row.kind === "removed"
            ? "diff-line-removed"
            : row.kind === "hunk"
              ? "diff-line-hunk"
              : null;

      if (!className) return;
      decorations.push({
        range: new monacoInstance.Range(index + 1, 1, index + 1, 1),
        options: { isWholeLine: true, className },
      });
    });

    for (const comment of comments) {
      const range = rowRangeForComment(
        rendered,
        comment.line_start,
        comment.line_end,
      );
      if (!range) continue;

      decorations.push({
        range: new monacoInstance.Range(range.startRow, 1, range.endRow, 1),
        options: {
          isWholeLine: true,
          className: "diff-line-commented",
          glyphMarginClassName: `diff-glyph diff-glyph-${comment.severity}`,
          glyphMarginHoverMessage: {
            value: range.exact
              ? comment.comment_text
              : `${comment.comment_text}\n\n_(lines ${comment.line_start}–${comment.line_end} are not in this diff — pinned to the nearest hunk)_`,
          },
        },
      });
    }

    // createDecorationsCollection, not the deprecated deltaDecorations the
    // issue specifies: the collection owns its ids, so replacing the set is
    // one call and there is no stale-id bookkeeping to get wrong.
    if (collectionRef.current) collectionRef.current.clear();
    collectionRef.current = editorInstance.createDecorationsCollection(decorations);
  }, [comments, rendered, mounted]);

  useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance || !focus) return;

    const row = rowRangeForComment(rendered, focus.line, focus.line)?.startRow;
    if (row) editorInstance.revealLineInCenter(row);
  }, [focus, rendered, mounted]);

  const height = Math.min(rendered.rows.length * LINE_HEIGHT + 16, MAX_HEIGHT);

  return (
    <Editor
      height={height}
      language={languageForPath(file.path)}
      value={rendered.text}
      theme={PAPER_THEME}
      beforeMount={setupMonaco}
      onMount={onMount}
      loading={<Spinner size="md" label="Loading the diff" />}
      options={{
        readOnly: true,
        domReadOnly: true,
        // Read-only, so Tab moves on rather than being swallowed as input.
        ariaLabel: `Diff for ${file.path}`,
        // The gutter shows *new-file* line numbers, blank on removed lines
        // and hunk headers, because that is the numbering review comments
        // are anchored to. A row's number and a comment's line agree.
        lineNumbers: (row) => String(rendered.rows[row - 1]?.newLineNo ?? ""),
        glyphMargin: true,
        lineHeight: LINE_HEIGHT,
        fontFamily: "var(--font-code)",
        fontSize: 12.5,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: "none",
        overviewRulerLanes: 0,
        folding: false,
        contextmenu: false,
        scrollbar: { alwaysConsumeMouseWheel: false },
        padding: { top: 8, bottom: 8 },
      }}
    />
  );
}
