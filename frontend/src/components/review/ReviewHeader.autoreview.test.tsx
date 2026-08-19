import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fixtureReviewCompleted } from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import { ReviewHeader } from "./ReviewHeader";

function render(overrides = {}, onChange = vi.fn()) {
  renderWithProviders(
    <ReviewHeader
      review={{ ...fixtureReviewCompleted, ...overrides }}
      onRereview={vi.fn()}
      onAutoReviewChange={onChange}
    />,
  );
  return onChange;
}

describe("ReviewHeader — review on every push", () => {
  it("is off by default, which is what every real pull request starts as", () => {
    render();
    expect(screen.getByLabelText("Review on every push")).not.toBeChecked();
  });

  it("reports a change without assuming it succeeded", async () => {
    const onChange = render();

    await userEvent.click(screen.getByLabelText("Review on every push"));

    // The checkbox stays driven by the server's value — the page invalidates
    // the detail query and the new value arrives from there. Flipping it
    // locally would show "on" for a PATCH that 404'd.
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByLabelText("Review on every push")).not.toBeChecked();
  });

  it("says what being on costs, only when it is on", () => {
    render({ auto_review: true });
    expect(screen.getByText(/each one spends model quota/)).toBeInTheDocument();
  });

  it("does not lecture someone who left it off", () => {
    render({ auto_review: false });
    expect(screen.queryByText(/spends model quota/)).not.toBeInTheDocument();
  });

  it("cannot be changed while a change is in flight", () => {
    renderWithProviders(
      <ReviewHeader
        review={fixtureReviewCompleted}
        onRereview={vi.fn()}
        onAutoReviewChange={vi.fn()}
        autoReviewSaving
      />,
    );
    expect(screen.getByLabelText("Review on every push")).toBeDisabled();
  });
});
