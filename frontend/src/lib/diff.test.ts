import { describe, expect, it } from "vitest";
import {
  languageForPath,
  parseDiff,
  renderFileDiff,
  rowForNewLine,
  rowRangeForComment,
} from "./diff";

const MULTI_FILE = `diff --git a/setup-mac.sh b/setup-mac.sh
index 1111111..2222222 100644
--- a/setup-mac.sh
+++ b/setup-mac.sh
@@ -1,5 +1,5 @@
-BREW_PREFIX=$HOME/.brew
+BREW_PREFIX="$HOME/.brew"
 export PATH="$BREW_PREFIX/bin:$PATH"

 echo "Installing dependencies..."
diff --git a/src/lib/diff.ts b/src/lib/diff.ts
--- a/src/lib/diff.ts
+++ b/src/lib/diff.ts
@@ -40,7 +40,9 @@ function parseHunkHeader(line: string): HunkHeader {
   const match = HUNK_HEADER_RE.exec(line);
   if (!match) throw new Error("Malformed hunk header");
-  const count = Number(match[2]);
+  const count = match[2] === undefined ? 1 : Number(match[2]);
   return { start: Number(match[1]), count };
 }
`;

describe("parseDiff", () => {
  it("splits a multi-file diff and keeps both paths", () => {
    const files = parseDiff(MULTI_FILE);

    expect(files.map((f) => f.path)).toEqual(["setup-mac.sh", "src/lib/diff.ts"]);
    expect(files[0].oldPath).toBe("setup-mac.sh");
    expect(files[0].status).toBe("modified");
  });

  it("numbers added, removed and context lines the way the backend does", () => {
    const [file] = parseDiff(MULTI_FILE);
    const lines = file.hunks[0].lines;

    expect(lines.map((l) => [l.kind, l.oldLineNo, l.newLineNo])).toEqual([
      ["removed", 1, null],
      ["added", null, 1],
      ["context", 2, 2],
      ["context", 3, 3],
      ["context", 4, 4],
    ]);
  });

  it("keeps the section text from the hunk header", () => {
    const files = parseDiff(MULTI_FILE);
    expect(files[1].hunks[0].section).toBe(
      "function parseHunkHeader(line: string): HunkHeader {",
    );
  });

  it("treats an omitted hunk count as 1, not 0", () => {
    // The exact bug the fixture review is about. A 0 here desyncs every line
    // number after this hunk.
    const [file] = parseDiff(
      `diff --git a/a.txt b/a.txt\n@@ -3 +3 @@\n-old\n+new\n`,
    );

    expect(file.hunks[0].oldCount).toBe(1);
    expect(file.hunks[0].newCount).toBe(1);
    expect(file.hunks[0].lines[1].newLineNo).toBe(3);
  });

  it("recognises a new file", () => {
    const [file] = parseDiff(
      `diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n`,
    );

    expect(file.status).toBe("added");
    expect(file.hunks[0].lines.map((l) => l.newLineNo)).toEqual([1, 2]);
  });

  it("recognises a deleted file and reports the old path as its path", () => {
    const [file] = parseDiff(
      `diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n@@ -1,2 +0,0 @@\n-one\n-two\n`,
    );

    expect(file.status).toBe("deleted");
    expect(file.path).toBe("gone.ts");
    expect(file.hunks[0].lines.every((l) => l.newLineNo === null)).toBe(true);
  });

  it("recognises a rename", () => {
    const [file] = parseDiff(
      `diff --git a/old.ts b/new.ts\nsimilarity index 95%\nrename from old.ts\nrename to new.ts\n@@ -1 +1 @@\n-a\n+b\n`,
    );

    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("old.ts");
    expect(file.path).toBe("new.ts");
  });

  it("flags a binary file and gives it no hunks", () => {
    const [file] = parseDiff(
      `diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n`,
    );

    expect(file.isBinary).toBe(true);
    expect(file.hunks).toEqual([]);
  });

  it("ignores the no-newline marker without counting it as a line", () => {
    const [file] = parseDiff(
      `diff --git a/a.txt b/a.txt\n@@ -1,2 +1,2 @@\n-one\n\\ No newline at end of file\n+one\n context\n`,
    );

    expect(file.hunks[0].lines.map((l) => l.kind)).toEqual([
      "removed",
      "added",
      "context",
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });

  it("skips a preamble before the first file header", () => {
    const files = parseDiff(`some junk\nmore junk\n${MULTI_FILE}`);
    expect(files).toHaveLength(2);
  });
});

describe("renderFileDiff", () => {
  it("puts each hunk header on its own row above its body", () => {
    const [file] = parseDiff(MULTI_FILE);
    const rendered = renderFileDiff(file);

    expect(rendered.rows[0]).toMatchObject({
      kind: "hunk",
      text: "@@ -1,5 +1,5 @@",
    });
    expect(rendered.rows[1]).toMatchObject({
      kind: "removed",
      text: "BREW_PREFIX=$HOME/.brew",
    });
    // 1 header + 5 body lines.
    expect(rendered.rows).toHaveLength(6);
    expect(rendered.text.split("\n")).toHaveLength(6);
  });

  it("keeps rows and text lines in step, which the gutter mapping relies on", () => {
    const [, file] = parseDiff(MULTI_FILE);
    const rendered = renderFileDiff(file);

    rendered.text.split("\n").forEach((line, index) => {
      expect(line).toBe(rendered.rows[index].text);
    });
  });
});

describe("rowForNewLine", () => {
  it("maps a new-file line to its editor row", () => {
    const [file] = parseDiff(MULTI_FILE);
    const rendered = renderFileDiff(file);

    // Row 1 is the @@ header, row 2 the removed line, row 3 the added line 1.
    expect(rowForNewLine(rendered, 1)).toBe(3);
    expect(rowForNewLine(rendered, 2)).toBe(4);
  });

  it("returns null for a line the diff never touched", () => {
    const [file] = parseDiff(MULTI_FILE);
    expect(rowForNewLine(renderFileDiff(file), 900)).toBeNull();
  });
});

describe("rowRangeForComment", () => {
  it("spans exactly the rows the comment covers", () => {
    const [file] = parseDiff(MULTI_FILE);
    const rendered = renderFileDiff(file);

    expect(rowRangeForComment(rendered, 1, 3)).toEqual({
      startRow: 3,
      endRow: 5,
      exact: true,
    });
  });

  it("handles a single-line comment", () => {
    const [file] = parseDiff(MULTI_FILE);
    expect(rowRangeForComment(renderFileDiff(file), 4, 4)).toEqual({
      startRow: 6,
      endRow: 6,
      exact: true,
    });
  });

  it("pins a comment on an untouched line to the nearest hunk header", () => {
    // The LLM sees retrieved context as well as the diff, so it can and does
    // comment on lines nobody changed.
    const [, file] = parseDiff(MULTI_FILE);
    const rendered = renderFileDiff(file);

    const range = rowRangeForComment(rendered, 500, 502)!;
    expect(range.exact).toBe(false);
    expect(rendered.rows[range.startRow - 1].kind).toBe("hunk");
  });

  it("picks the nearer of two hunks", () => {
    const [file] = parseDiff(
      `diff --git a/a.ts b/a.ts
@@ -1,2 +1,2 @@
-a
+a2
@@ -80,2 +80,2 @@
-b
+b2
`,
    );
    const rendered = renderFileDiff(file);

    // Line 78 is closest to the second hunk, which starts at row 4.
    const range = rowRangeForComment(rendered, 78, 78)!;
    expect(range).toEqual({ startRow: 4, endRow: 4, exact: false });
  });

  it("returns null for a file with nothing rendered", () => {
    expect(rowRangeForComment({ text: "", rows: [] }, 1, 2)).toBeNull();
  });
});

describe("languageForPath", () => {
  it.each([
    ["src/lib/diff.ts", "typescript"],
    ["app/main.py", "python"],
    ["setup-mac.sh", "shell"],
    ["Dockerfile", "dockerfile"],
    ["backend/Dockerfile", "dockerfile"],
    ["README.md", "markdown"],
    ["LICENSE", "plaintext"],
    ["weird.qqq", "plaintext"],
  ])("%s → %s", (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });
});
