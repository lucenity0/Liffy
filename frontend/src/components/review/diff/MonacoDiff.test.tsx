import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDiff } from "@/lib/diff";
import { DEFAULT_THEME, THEMES } from "@/lib/themes";
import type { ReviewCommentOut } from "@/types/api";

/**
 * Monaco never runs in jsdom — it wants a real layout engine — so the editor
 * is replaced with a stub that captures what the component asked it to do.
 * That is the whole surface worth testing here: decoration ranges, the gutter
 * mapping, and the two reveal calls. Everything upstream of it is pure and
 * covered in lib/diff.test.ts.
 */

interface CapturedDecoration {
  range: { startLineNumber: number; endLineNumber: number };
  options: {
    className?: string;
    glyphMarginClassName?: string;
    isWholeLine?: boolean;
  };
}

const captured = {
  decorations: [] as CapturedDecoration[],
  revealed: [] as number[],
  lineNumbers: undefined as ((row: number) => string) | undefined,
  value: "",
  language: "",
  theme: "",
  mouseDown: undefined as ((event: unknown) => void) | undefined,
};

const editorStub = {
  createDecorationsCollection: (decorations: CapturedDecoration[]) => {
    captured.decorations = decorations;
    return { clear: vi.fn() };
  },
  onMouseDown: (handler: (event: unknown) => void) => {
    captured.mouseDown = handler;
  },
  revealLineInCenter: (line: number) => captured.revealed.push(line),
};

const monacoStub = {
  // Plain assignments rather than parameter properties: `erasableSyntaxOnly`
  // is on, and parameter properties are the one class feature it forbids.
  Range: class {
    startLineNumber: number;
    endLineNumber: number;

    // The real Range takes a trailing endColumn we have no use for; extra
    // arguments to a shorter constructor are simply ignored.
    constructor(
      startLineNumber: number,
      _startColumn: number,
      endLineNumber: number,
    ) {
      this.startLineNumber = startLineNumber;
      this.endLineNumber = endLineNumber;
    }
  },
};

vi.mock("./monacoSetup", () => ({
  // The real one resolves the palette through a hidden probe, which needs
  // layout jsdom does not do. The naming contract is what matters here.
  ensureTheme: (theme: string) => `liffy-${theme}`,
  monacoThemeName: (theme: string) => `liffy-${theme}`,
  setupMonaco: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  // Uppercase name: it really is a component, and the hooks lint checks that.
  default: function EditorStub({
    onMount,
    options,
    value,
    language,
    theme,
  }: {
    onMount: (editor: unknown, monaco: unknown) => void;
    options: { lineNumbers?: (row: number) => string };
    value: string;
    language: string;
    theme: string;
  }) {
    captured.lineNumbers = options.lineNumbers;
    captured.value = value;
    captured.language = language;
    captured.theme = theme;

    useEffect(() => {
      // Asynchronously, once — which is what the real editor does, and what
      // makes the decoration effect run before the refs exist. Calling
      // onMount synchronously here would hide exactly that bug.
      const id = setTimeout(() => onMount(editorStub, monacoStub), 0);
      return () => clearTimeout(id);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return <div data-testid="monaco" />;
  },
}));

const { default: MonacoDiff } = await import("./MonacoDiff");

const RAW = `diff --git a/src/lib/diff.ts b/src/lib/diff.ts
--- a/src/lib/diff.ts
+++ b/src/lib/diff.ts
@@ -1,6 +1,6 @@
 const HEADER = /x/;

-export function parse(raw) {
+export function parse(raw: string) {
   return raw;
 }
`;

const [file] = parseDiff(RAW);

function comment(overrides: Partial<ReviewCommentOut> = {}): ReviewCommentOut {
  return {
    id: "c1",
    file_path: "src/lib/diff.ts",
    line_start: 3,
    line_end: 5,
    category: "logic_error",
    severity: "critical",
    comment_text: "This is wrong.",
    suggestion: null,
    created_at: "2026-07-26T10:00:00Z",
    confidence: null,
    failure_scenario: null,
    my_rating: null,
    ...overrides,
  };
}

beforeEach(() => {
  captured.decorations = [];
  captured.revealed = [];
  captured.mouseDown = undefined;
});

describe("MonacoDiff", () => {
  it("renders the hunk rows as the editor's text, with the file's language", () => {
    render(<MonacoDiff file={file} comments={[]} />);

    expect(screen.getByTestId("monaco")).toBeInTheDocument();
    expect(captured.language).toBe("typescript");
    // Header row, then the hunk body — no blank padding lines.
    expect(captured.value.split("\n")[0]).toBe("@@ -1,6 +1,6 @@");
    expect(captured.value.split("\n")).toHaveLength(7);
  });

  it("puts real new-file line numbers in the gutter, and nothing on removed rows", () => {
    render(<MonacoDiff file={file} comments={[]} />);
    const gutter = captured.lineNumbers!;

    expect(gutter(1)).toBe(""); // the @@ header
    expect(gutter(2)).toBe("1"); // context
    expect(gutter(4)).toBe(""); // removed — it has no new-file line
    expect(gutter(5)).toBe("3"); // the added line replacing it
  });

  it("tints added, removed and hunk rows and leaves context alone", async () => {
    render(<MonacoDiff file={file} comments={[]} />);
    await waitFor(() => expect(captured.decorations.length).toBeGreaterThan(0));

    const byClass = (className: string) =>
      captured.decorations
        .filter((d) => d.options.className === className)
        .map((d) => d.range.startLineNumber);

    expect(byClass("diff-line-hunk")).toEqual([1]);
    expect(byClass("diff-line-removed")).toEqual([4]);
    expect(byClass("diff-line-added")).toEqual([5]);
    // 1 header + 1 removed + 1 added out of 7 rows; the rest are context.
    expect(
      captured.decorations.filter((d) => d.options.className?.startsWith("diff-line-")),
    ).toHaveLength(3);
  });

  it("decorates a comment across exactly the rows it covers, with a severity glyph", async () => {
    render(<MonacoDiff file={file} comments={[comment()]} />);
    await waitFor(() => expect(captured.decorations.length).toBeGreaterThan(0));

    const marker = captured.decorations.find(
      (d) => d.options.className === "diff-line-commented",
    )!;

    // Comment on new-file lines 3-5: row 5 is line 3, row 7 is line 5.
    expect(marker.range.startLineNumber).toBe(5);
    expect(marker.range.endLineNumber).toBe(7);
    expect(marker.options.glyphMarginClassName).toBe(
      "diff-glyph diff-glyph-critical",
    );
    expect(marker.options.isWholeLine).toBe(true);
  });

  it("still shows a comment whose lines are not in the diff, pinned to a hunk header", async () => {
    render(
      <MonacoDiff
        file={file}
        comments={[comment({ line_start: 900, line_end: 902 })]}
      />,
    );
    await waitFor(() => expect(captured.decorations.length).toBeGreaterThan(0));

    const marker = captured.decorations.find(
      (d) => d.options.className === "diff-line-commented",
    )!;
    // Row 1 is the @@ header. Dropping the comment would hide a real finding.
    expect(marker.range.startLineNumber).toBe(1);
  });

  it("reveals the mapped row when the page focuses a comment", async () => {
    const { rerender } = render(
      <MonacoDiff file={file} comments={[comment()]} focus={null} />,
    );
    await waitFor(() => expect(captured.decorations.length).toBeGreaterThan(0));
    expect(captured.revealed).toEqual([]);

    rerender(
      <MonacoDiff file={file} comments={[comment()]} focus={{ line: 3 }} />,
    );
    expect(captured.revealed).toEqual([5]);

    // A fresh object for the same line reveals again — clicking the same
    // comment twice has to work.
    rerender(
      <MonacoDiff file={file} comments={[comment()]} focus={{ line: 3 }} />,
    );
    expect(captured.revealed).toEqual([5, 5]);
  });

  it("reports a click on a commented row back to the page", async () => {
    const onGlyphClick = vi.fn();
    render(
      <MonacoDiff file={file} comments={[comment()]} onGlyphClick={onGlyphClick} />,
    );
    await waitFor(() => expect(captured.mouseDown).toBeDefined());

    captured.mouseDown!({ target: { position: { lineNumber: 5 } } });
    expect(onGlyphClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1" }),
    );

    onGlyphClick.mockClear();
    captured.mouseDown!({ target: { position: { lineNumber: 2 } } });
    expect(onGlyphClick).not.toHaveBeenCalled();
  });
});

/**
 * Monaco is the one surface the CSS cascade cannot reach — it does not read
 * custom properties, so the theme has to be handed to it by name. That makes
 * this the only part of a theme that can be wrong while every other pixel on
 * the page is right, which is why it gets its own test.
 */
describe("theme", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it.each(THEMES.map((spec) => spec.id))(
    "asks Monaco for the editor theme matching %s",
    (id) => {
      document.documentElement.dataset.theme = id;

      render(<MonacoDiff file={file} comments={[]} />);
      expect(captured.theme).toBe(`liffy-${id}`);
    },
  );

  it("falls back to the default theme when the attribute is missing", () => {
    render(<MonacoDiff file={file} comments={[]} />);
    expect(captured.theme).toBe(`liffy-${DEFAULT_THEME}`);
  });
});
