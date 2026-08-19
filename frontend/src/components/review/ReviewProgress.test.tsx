import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixtureReviewPending, fixtureReviewProcessing } from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import { ReviewProgress } from "./ReviewProgress";

describe("ReviewProgress — the side of the panel that used to be empty", () => {
  it("shows the scene beside a running review", () => {
    renderWithProviders(<ReviewProgress review={fixtureReviewProcessing} />);

    expect(
      screen.getByRole("img", { name: /glowing monitor, its screen scrolling/ }),
    ).toBeInTheDocument();
  });

  it("names no file on the screen, because nothing knows which one is being read", () => {
    renderWithProviders(<ReviewProgress review={fixtureReviewProcessing} />);

    // A review is one model call, so the worker cannot know which file has the
    // model's attention. A screen scrolling real filenames would be inventing
    // telemetry on the panel whose stated rule is that every state is derived
    // from something the API proves.
    expect(screen.queryByText("backend/app/llm/chain.py")).not.toBeInTheDocument();
    expect(screen.queryByText(/reading/i)).not.toBeInTheDocument();
  });

  it("shows no scene beside a queued review, which has not started", () => {
    renderWithProviders(
      <ReviewProgress review={{ ...fixtureReviewPending, raw_diff: null }} />,
    );

    expect(screen.queryByRole("img", { name: /monitor/ })).not.toBeInTheDocument();
  });

  it("still reports the file count, which is the part that carries meaning", () => {
    renderWithProviders(<ReviewProgress review={fixtureReviewProcessing} />);

    const panel = screen.getByRole("region", { name: "Review progress" });
    expect(within(panel).getByText("7 changed files")).toBeInTheDocument();
  });
});
