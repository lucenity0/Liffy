import { describe, expect, it } from "vitest";
import { groupCommentsByFile, severityRank } from "./reviewUtils";
import type { ReviewCommentOut } from "@/types/api";

let seq = 0;
function comment(
  overrides: Partial<ReviewCommentOut> & Pick<ReviewCommentOut, "file_path">,
): ReviewCommentOut {
  seq += 1;
  return {
    id: `c${seq}`,
    line_start: 1,
    line_end: 1,
    category: "improvement",
    severity: "info",
    comment_text: "…",
    suggestion: null,
    created_at: "2026-07-26T10:00:00Z",
    confidence: null,
    failure_scenario: null,
    my_rating: null,
    ...overrides,
  };
}

describe("groupCommentsByFile", () => {
  it("returns nothing for a review with no comments", () => {
    expect(groupCommentsByFile([])).toEqual([]);
  });

  it("groups by file, alphabetically, whatever order the LLM emitted them in", () => {
    const groups = groupCommentsByFile([
      comment({ file_path: "src/z.ts" }),
      comment({ file_path: "a.py" }),
      comment({ file_path: "src/z.ts" }),
    ]);

    expect(groups.map((g) => g.filePath)).toEqual(["a.py", "src/z.ts"]);
    expect(groups[1].comments).toHaveLength(2);
  });

  it("orders a file's comments the way you would read the diff", () => {
    const groups = groupCommentsByFile([
      comment({ file_path: "a.ts", line_start: 40, line_end: 44 }),
      comment({ file_path: "a.ts", line_start: 4, line_end: 6 }),
      comment({ file_path: "a.ts", line_start: 12, line_end: 12 }),
    ]);

    expect(groups[0].comments.map((c) => c.line_start)).toEqual([4, 12, 40]);
  });

  it("breaks a line_start tie on line_end rather than leaving it to sort stability", () => {
    const groups = groupCommentsByFile([
      comment({ file_path: "a.ts", line_start: 10, line_end: 40 }),
      comment({ file_path: "a.ts", line_start: 10, line_end: 12 }),
    ]);

    expect(groups[0].comments.map((c) => c.line_end)).toEqual([12, 40]);
  });

  it("reports the worst severity in each file", () => {
    const groups = groupCommentsByFile([
      comment({ file_path: "a.ts", severity: "info" }),
      comment({ file_path: "a.ts", line_start: 2, severity: "critical" }),
      comment({ file_path: "b.ts", severity: "warning" }),
      comment({ file_path: "b.ts", line_start: 2, severity: "info" }),
    ]);

    expect(groups.map((g) => g.worst)).toEqual(["critical", "warning"]);
  });

  it("does not mutate the array it was handed", () => {
    const input = [
      comment({ file_path: "a.ts", line_start: 9 }),
      comment({ file_path: "a.ts", line_start: 1 }),
    ];
    const order = input.map((c) => c.id);

    groupCommentsByFile(input);

    expect(input.map((c) => c.id)).toEqual(order);
  });
});

describe("severityRank", () => {
  it("sorts worst-first", () => {
    expect(severityRank("critical")).toBeLessThan(severityRank("warning"));
    expect(severityRank("warning")).toBeLessThan(severityRank("info"));
  });
});
