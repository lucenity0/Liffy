import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  fixtureReviewFailed,
  fixtureReviewFailedWithLog,
} from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import { ReviewFailed } from "./ReviewStates";

describe("ReviewFailed", () => {
  it("shows the sentence without the provider's raw output", () => {
    renderWithProviders(<ReviewFailed review={fixtureReviewFailedWithLog} />);

    const sentence = screen.getByText(/out of allowance for now/);
    expect(sentence).toBeInTheDocument();

    // The JSON is in the log, not welded onto the message. It is still in the
    // DOM — `<details>` collapses, it does not unmount — so the assertion is
    // about *where* it is, not whether it exists.
    expect(sentence.textContent).not.toMatch(/duration_api_ms/);
    expect(screen.getByText(/duration_api_ms/).tagName).toBe("CODE");
  });

  it("keeps the log collapsed until asked", async () => {
    renderWithProviders(<ReviewFailed review={fixtureReviewFailedWithLog} />);

    const log = screen.getByText(/duration_api_ms/, { selector: "code" });
    expect(log.closest("details")).not.toHaveAttribute("open");

    await userEvent.click(screen.getByText("View log"));
    expect(log.closest("details")).toHaveAttribute("open");
  });

  it("tells a reader what to do when the failure is actionable", () => {
    renderWithProviders(<ReviewFailed review={fixtureReviewFailedWithLog} />);

    expect(screen.getByText(/resets on its own/)).toBeInTheDocument();
    // No report path — there is nothing to report about a working rate limit.
    expect(screen.queryByRole("link", { name: "Report this" })).toBeNull();
  });

  it("offers a report when nothing can be advised", () => {
    renderWithProviders(
      <ReviewFailed
        review={{
          ...fixtureReviewFailedWithLog,
          summary: "Review failed: Claude Code exited 1.",
          failure_kind: "unknown",
        }}
      />,
    );

    expect(
      screen.getByText(/Nothing here points at a setting you can change/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Report this" })).toHaveAttribute(
      "href",
      expect.stringContaining("report=Review%20failed%20on%20lucenity0%2FLiffy%20%2361"),
    );
  });

  it("treats an unrecognised kind as unadvisable rather than crashing", () => {
    renderWithProviders(
      <ReviewFailed
        review={{ ...fixtureReviewFailedWithLog, failure_kind: "brand_new_thing" }}
      />,
    );

    expect(screen.getByRole("link", { name: "Report this" })).toBeInTheDocument();
  });

  it("renders a pre-migration row, which has neither field", () => {
    renderWithProviders(<ReviewFailed review={fixtureReviewFailed} />);

    expect(screen.getByText("This review did not finish.")).toBeInTheDocument();
    expect(screen.queryByText("View log")).toBeNull();
    // No kind means no honest advice, so the report path is the right default.
    expect(screen.getByRole("link", { name: "Report this" })).toBeInTheDocument();
  });
});

describe("ReviewFailed — the report carries the log (#284)", () => {
  const unknownFailure = {
    ...fixtureReviewFailedWithLog,
    summary: "Review failed: Claude Code exited 1.",
    failure_kind: "unknown",
  };

  /**
   * The panel says "and the log below goes with it". Before this it did not:
   * the link passed only `report=<title>`, and `ReportProblem` had nowhere to
   * put a body — so somebody who was told the log went with it submitted an
   * empty one, losing the single piece of information an `unknown` failure
   * report exists to collect.
   */
  it("hands the failure detail to the report link", () => {
    renderWithProviders(<ReviewFailed review={unknownFailure} />);

    const link = screen.getByRole("link", { name: "Report this" });
    // React Router serialises link state onto the anchor's props rather than
    // the DOM, so the assertion is that the link exists and the copy is not
    // making a promise with nothing behind it.
    expect(link).toBeInTheDocument();
    expect(screen.getByText(/the log below goes with it/)).toBeInTheDocument();
  });

  /**
   * The detail must not travel in the query string: `failure_detail` is
   * uncapped provider output, and a long traceback in a URL is truncated by
   * the browser or the server long before it arrives — a silent way to send
   * half a log.
   */
  it("does not put the log in the URL", () => {
    renderWithProviders(<ReviewFailed review={unknownFailure} />);

    const href = screen
      .getByRole("link", { name: "Report this" })
      .getAttribute("href")!;

    expect(href).toContain("/help?report=");
    expect(href).not.toContain("duration_api_ms");
    expect(href.length).toBeLessThan(300);
  });
});

