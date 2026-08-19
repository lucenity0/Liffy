import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixtureReviewProcessing, fixtureReviewPending } from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import { ReviewProgress } from "./ReviewProgress";

const PATHS = [
  "one.py",
  "two.ts",
  "three.md",
  "four.tsx",
  "five.py",
  "six.ts",
  "seven.md",
];

/** `parseDiff` requires the real `a/… b/…` shape — see DIFF_GIT_RE. */
const RAW_DIFF = PATHS.map(
  (p) =>
    `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,2 @@\n keep\n+added\n`,
).join("");

function processing(overrides = {}) {
  return { ...fixtureReviewProcessing, raw_diff: RAW_DIFF, ...overrides };
}

describe("ReviewProgress — the side panel", () => {
  it("shows the files actually in the diff, not an invented ticker", () => {
    renderWithProviders(<ReviewProgress review={processing()} />);

    // `raw_diff` is populated before the row is inserted, so this really is
    // the set being worked through — which is what makes showing it honest.
    expect(screen.getByText("one.py")).toBeInTheDocument();
    expect(screen.getByText("two.ts")).toBeInTheDocument();
  });

  it("labels the list by what it is, not by what it is not doing", () => {
    renderWithProviders(<ReviewProgress review={processing()} />);

    // A review is one model call: nothing knows which file has the model's
    // attention, so "reading now" would be invented telemetry on a panel
    // whose rule is that every state is derived from something proven.
    expect(screen.getByText("In this review")).toBeInTheDocument();
    expect(screen.queryByText(/reading/i)).not.toBeInTheDocument();
  });

  it("truncates a long list rather than scrolling forever", () => {
    renderWithProviders(<ReviewProgress review={processing()} />);

    expect(screen.getByText("and 1 more")).toBeInTheDocument();
  });

  it("shows nothing beside a queued review, which has no diff yet", () => {
    renderWithProviders(
      <ReviewProgress review={{ ...fixtureReviewPending, raw_diff: null }} />,
    );

    expect(screen.queryByText("In this review")).not.toBeInTheDocument();
  });

  it("still reports the step list, which is the part that carries meaning", () => {
    renderWithProviders(<ReviewProgress review={processing()} />);

    const panel = screen.getByRole("region", { name: "Review progress" });
    expect(within(panel).getByText("7 changed files")).toBeInTheDocument();
  });
});
