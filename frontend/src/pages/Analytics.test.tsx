import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import {
  fixtureAnalyticsEmpty,
  fixtureAnalyticsPartial,
  fixtureAnalyticsSummary,
} from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import type { AnalyticsSummaryOut } from "@/types/api";
import { Analytics } from "./Analytics";

function withSummary(summary: AnalyticsSummaryOut) {
  server.use(
    http.get("*/analytics/summary", () => HttpResponse.json(summary)),
  );
}

function render() {
  return renderWithProviders(<Analytics />);
}

const tile = (name: string) => screen.findByRole("region", { name });

describe("Analytics — populated", () => {
  it("renders a tile for every metric §8.1 sets a target for", async () => {
    render();

    expect(await tile("Approval rate")).toBeInTheDocument();
    expect(await tile("Time to review")).toBeInTheDocument();
    expect(await tile("Token efficiency")).toBeInTheDocument();
  });

  it("shows the run counts", async () => {
    render();

    const counts = await tile("Reviews run");
    expect(within(counts).getByText("14")).toBeInTheDocument();
    expect(within(counts).getByText("12")).toBeInTheDocument();
    expect(within(counts).getByText("2")).toBeInTheDocument();
  });

  it("marks approval rate as met when it is above target", async () => {
    render();

    const approval = await tile("Approval rate");
    expect(within(approval).getByText("83%")).toBeInTheDocument();
    expect(within(approval).getByText("Meets target")).toBeInTheDocument();
  });

  it("marks approval rate as missed when it is below target", async () => {
    withSummary({
      ...fixtureAnalyticsSummary,
      approval_rate: {
        ...fixtureAnalyticsSummary.approval_rate,
        value: 0.4,
        met: false,
      },
    });
    render();

    const approval = await tile("Approval rate");
    expect(within(approval).getByText("40%")).toBeInTheDocument();
    expect(within(approval).getByText("Below target")).toBeInTheDocument();
  });

  /**
   * The headline test. `met` is `null` exactly when `value` is, and treating
   * that as `false` tells someone they are failing a target nobody has
   * measured — the same `null`-versus-zero distinction #191 and #199 preserve,
   * carried one layer further out.
   */
  it("marks a null rate as unknown, not as missed", async () => {
    withSummary(fixtureAnalyticsPartial);
    render();

    const approval = await tile("Approval rate");
    expect(within(approval).getByText("Not measured yet")).toBeInTheDocument();
    expect(within(approval).queryByText("Below target")).not.toBeInTheDocument();
    expect(within(approval).queryByText("Meets target")).not.toBeInTheDocument();
  });

  /**
   * `?? 0` on any rate renders a plausible-looking `0%` and would pass every
   * other assertion in this file, so the absence of that string across the
   * whole page is the thing being checked.
   */
  it("renders no 0% anywhere when the rates are null", async () => {
    withSummary(fixtureAnalyticsPartial);
    render();

    await tile("Approval rate");
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText(/^0%$/)).not.toBeInTheDocument();
  });

  /**
   * The state the page spends most of its life in: durations land the moment
   * a review finishes, ratings only when somebody clicks. Per-tile unknowns,
   * not a whole-page empty state — building it the other way round is how a
   * real duration ends up hidden behind "no data".
   */
  it("renders the partial state: a real duration beside an unknown approval", async () => {
    withSummary(fixtureAnalyticsPartial);
    render();

    const duration = await tile("Time to review");
    expect(within(duration).getByText("72.4s")).toBeInTheDocument();
    expect(within(duration).getByText("Meets target")).toBeInTheDocument();

    const approval = await tile("Approval rate");
    expect(within(approval).getByText("Not measured yet")).toBeInTheDocument();
    // The page is emphatically not empty.
    expect(screen.queryByText(/nothing to measure yet/i)).not.toBeInTheDocument();
  });

  /**
   * The contract exists so §8.1 can move without a frontend release. A
   * hardcoded `0.7` passes every other test in this file, because every other
   * fixture happens to use the real target.
   */
  it("reads targets from the response rather than hardcoding them", async () => {
    withSummary({
      ...fixtureAnalyticsSummary,
      approval_rate: {
        ...fixtureAnalyticsSummary.approval_rate,
        // A target §8.1 does not set, met by a value that would fail the real
        // one — so a hardcoded 0.7 renders the wrong badge as well as the
        // wrong number.
        value: 0.45,
        target: 0.4,
        met: true,
      },
    });
    render();

    const approval = await tile("Approval rate");
    expect(within(approval).getByText(/Target > 40%/)).toBeInTheDocument();
    expect(within(approval).getByText("Meets target")).toBeInTheDocument();
    expect(within(approval).queryByText(/70%/)).not.toBeInTheDocument();
  });

  it("shows each metric's sample size next to it", async () => {
    render();

    expect(
      within(await tile("Approval rate")).getByText(/6 rated comments/),
    ).toBeInTheDocument();
    // Smaller than reviews_completed, because total_ms is NULL on manual
    // triggers and re-reviews.
    expect(
      within(await tile("Time to review")).getByText(/9 webhook-triggered reviews/),
    ).toBeInTheDocument();
  });

  /**
   * §8.1 asks for both, but they are one number: a thumbs-down records no
   * reason, so false positives are exactly `1 - approval` (ADR 004). The
   * figure is on the page; the pass/fail judgement is made once, on approval,
   * so the 70–80% band cannot show a pass and a fail for the same clicks.
   */
  it("shows the false-positive rate as the complement, not as a second verdict", async () => {
    render();

    const approval = await tile("Approval rate");
    expect(within(approval).getByText(/17%/)).toBeInTheDocument();
    expect(within(approval).getByText(/inverse of the approval rate/i)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "False positive rate" })).toBeNull();
    // One verdict on the page for these two figures, not two.
    expect(screen.getAllByText("Meets target")).toHaveLength(2); // approval + time
  });

  /**
   * `duration_ms` measures run_review's internals and cannot see time spent
   * queued. Presenting it as time-to-review would put a number in the report
   * the code does not measure.
   */
  it("names the pipeline figure separately and says the difference is queue wait", async () => {
    render();

    const duration = await tile("Time to review");
    expect(within(duration).getByText("41.2s")).toBeInTheDocument();
    expect(within(duration).getByText(/queue wait/i)).toBeInTheDocument();
  });

  it("renders token efficiency without a target, since §8.1 sets none", async () => {
    render();

    const efficiency = await tile("Token efficiency");
    expect(within(efficiency).getByText("0.033")).toBeInTheDocument();
    expect(within(efficiency).queryByText(/target/i)).not.toBeInTheDocument();
    expect(within(efficiency).queryByText("Meets target")).not.toBeInTheDocument();
  });
});

describe("Analytics — comments per review", () => {
  /** 8 comments across 12 completed reviews. */
  it("divides the comment total by the completed reviews", async () => {
    render();

    const tile_ = await tile("Comments per review");
    expect(within(tile_).getByText("0.7")).toBeInTheDocument();
    expect(
      within(tile_).getByText(/8 comments across 12 completed reviews/),
    ).toBeInTheDocument();
  });

  /**
   * No target, and deliberately so: a low number on clean code is the system
   * working, the same number on a broken pull request is the system missing
   * things. A pass/fail badge here would be a judgement the data cannot make.
   */
  it("carries no target and no verdict badge", async () => {
    render();

    const tile_ = await tile("Comments per review");
    expect(within(tile_).queryByText(/^Target/)).not.toBeInTheDocument();
    expect(within(tile_).queryByText("Meets target")).not.toBeInTheDocument();
    expect(within(tile_).queryByText("Below target")).not.toBeInTheDocument();
  });

  /**
   * `reviews_completed` is the denominator, and it is 0 whenever every review
   * is still running or has failed. `8 / 0` is `Infinity`, which renders as
   * the string "Infinity" — a number, sitting where a measurement goes.
   */
  it("shows an unknown rather than dividing by zero", async () => {
    withSummary({
      ...fixtureAnalyticsSummary,
      reviews_total: 3,
      reviews_completed: 0,
      reviews_failed: 3,
    });
    render();

    const tile_ = await tile("Comments per review");
    expect(within(tile_).getByText("—")).toBeInTheDocument();
    expect(within(tile_).queryByText(/Infinity|NaN/)).not.toBeInTheDocument();
    expect(
      within(tile_).getByText(/Needs at least one completed review/),
    ).toBeInTheDocument();
  });

  /**
   * The `other` bucket counts. Summing only the six known keys would
   * undercount the numerator, and an average that quietly ignores comments is
   * worse than no average.
   */
  it("counts a non-zero 'other' bucket in the total", async () => {
    withSummary({
      ...fixtureAnalyticsSummary,
      category_distribution: {
        ...fixtureAnalyticsSummary.category_distribution,
        other: 4,
      },
    });
    render();

    // 12 comments now, not 8.
    const tile_ = await tile("Comments per review");
    expect(within(tile_).getByText("1.0")).toBeInTheDocument();
    expect(
      within(tile_).getByText(/12 comments across 12 completed reviews/),
    ).toBeInTheDocument();
  });
});

describe("Analytics — charts", () => {
  it("renders the shape metrics alongside the tiles", async () => {
    render();

    expect(await tile("Category distribution")).toBeInTheDocument();
    expect(await tile("Token efficiency trend")).toBeInTheDocument();
    expect(await tile("Severity calibration")).toBeInTheDocument();
    expect(await tile("Flagged reviews")).toBeInTheDocument();
    // Still there — the charts sit beside the tiles, not instead of them.
    expect(await tile("Approval rate")).toBeInTheDocument();
  });

  /**
   * Half the categories never fired on the first real `claude-opus-5` review.
   * Against a target of "even spread" that is the finding, and it only exists
   * on screen if the zero bars render.
   */
  it("shows the zero-count categories rather than dropping them", async () => {
    render();

    const chart = await tile("Category distribution");
    expect(within(chart).getAllByText("0")).toHaveLength(3);
    expect(within(chart).getByText("Security")).toBeInTheDocument();
  });

  /**
   * Every scale here has a plausible empty domain, and a NaN width renders as
   * nothing with no error — so the page has to survive the whole response
   * being zeros, which is what a fresh-but-not-empty account looks like.
   */
  it("renders every chart without NaN when the data is empty", async () => {
    withSummary({
      ...fixtureAnalyticsEmpty,
      // Reviews exist, so this is not the whole-page empty state — but
      // nothing has produced a comment, a token count or a rating yet.
      reviews_total: 3,
      reviews_completed: 3,
    });
    const { container } = render();

    await tile("Category distribution");
    expect(container.innerHTML).not.toContain("NaN");
    expect(screen.getByText(/nothing to plot yet/i)).toBeInTheDocument();
    expect(screen.getByText("Nothing flagged.")).toBeInTheDocument();
  });
});

describe("Analytics — the other three states", () => {
  it("renders an empty state for an account with no reviews", async () => {
    withSummary(fixtureAnalyticsEmpty);
    render();

    expect(
      await screen.findByText("Nothing to measure yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /connect a repository/i }),
    ).toHaveAttribute("href", "/");
    // No tiles full of dashes behind it — that reads as broken, not as new.
    expect(screen.queryByRole("region", { name: "Approval rate" })).toBeNull();
  });

  it("renders skeletons in the tile layout while loading", () => {
    render();

    // Synchronously, before the request resolves: the tile count is known
    // ahead of time, so the page holds its shape instead of jumping.
    expect(screen.queryByRole("region", { name: "Approval rate" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument();
  });

  it("shows an error note without taking the page heading with it", async () => {
    server.use(
      http.get("*/analytics/summary", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    render();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("boom");
    expect(within(alert).getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument();
  });
});
