import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/renderWithProviders";
import { categoryLabel } from "@/lib/categories";
import { fixtureAnalyticsSummary } from "@/mocks/fixtures";
import type {
  FlaggedReview,
  SeverityCalibrationRow,
  TokenEfficiencyPoint,
} from "@/types/api";
import { CategoryDistribution } from "./CategoryDistribution";
import { FlaggedReviews } from "./FlaggedReviews";
import { SeverityCalibration } from "./SeverityCalibration";
import { TokenEfficiencyTrend } from "./TokenEfficiencyTrend";

/**
 * The first real `claude-opus-5` review (PR #58, assessed on #164): eight
 * comments, and half the categories never fired. Against a target of "even
 * spread" that is the most interesting thing the evaluation layer has said so
 * far — and it is only visible if the zero bars render.
 */
const FIRST_REAL_REVIEW = fixtureAnalyticsSummary.category_distribution;

describe("CategoryDistribution", () => {
  it("renders a bar for every category, including the zero-count ones", () => {
    renderWithProviders(<CategoryDistribution distribution={FIRST_REAL_REVIEW} />);

    const chart = screen.getByRole("region", { name: "Category distribution" });
    for (const key of [
      "logic_error",
      "security",
      "performance",
      "architecture",
      "convention",
      "improvement",
    ]) {
      expect(within(chart).getByText(categoryLabel(key))).toBeInTheDocument();
    }
    // Three of them are zero, and those are the finding.
    expect(within(chart).getAllByText("0")).toHaveLength(3);
  });

  /** A chart you cannot read exact values off is worse than a table. */
  it("labels each bar with its exact count", () => {
    renderWithProviders(<CategoryDistribution distribution={FIRST_REAL_REVIEW} />);

    const chart = screen.getByRole("region", { name: "Category distribution" });
    expect(within(chart).getByText("5")).toBeInTheDocument();
    expect(within(chart).getByText("2")).toBeInTheDocument();
    expect(within(chart).getByText("1")).toBeInTheDocument();
  });

  it("sorts by count descending", () => {
    const { container } = renderWithProviders(
      <CategoryDistribution distribution={FIRST_REAL_REVIEW} />,
    );

    const labels = [...container.querySelectorAll("svg text")]
      .map((node) => node.textContent)
      .filter((text) => text && !/^\d+$/.test(text));
    expect(labels[0]).toBe(categoryLabel("logic_error"));
    expect(labels[1]).toBe(categoryLabel("improvement"));
    expect(labels[2]).toBe(categoryLabel("convention"));
  });

  /**
   * `badgeMaps.tsx` carries a written decision that categories are
   * monochrome — severity is what you triage by, so severity carries hue.
   * Six new hues here would contradict it on the same page as the badges that
   * follow it, so the chart reuses the labels and distinguishes by position.
   */
  it("reuses the badge labels and introduces no second category mapping", () => {
    const { container } = renderWithProviders(
      <CategoryDistribution distribution={FIRST_REAL_REVIEW} />,
    );

    expect(screen.getByText(categoryLabel("logic_error"))).toBeInTheDocument();
    const fills = [...container.querySelectorAll("rect")].map(
      (node) => node.getAttribute("class") ?? "",
    );
    for (const fill of fills) {
      expect(fill).not.toMatch(/fill-(oxide|sage|ochre|payne)/);
    }
  });

  /**
   * `count / 0` is `NaN`, and SVG renders a NaN width as nothing at all — no
   * error, no bar, no clue why. Every scale on this page has a plausible
   * empty domain.
   */
  it("does not produce NaN when every count is zero", () => {
    const { container } = renderWithProviders(
      <CategoryDistribution
        distribution={{
          logic_error: 0,
          security: 0,
          performance: 0,
          architecture: 0,
          convention: 0,
          improvement: 0,
        }}
      />,
    );

    for (const rect of container.querySelectorAll("rect")) {
      expect(rect.getAttribute("width")).not.toContain("NaN");
    }
    expect(screen.getByText(/no comments yet/i)).toBeInTheDocument();
  });

  /** A bucket for values outside the enum, not a seventh category. */
  it("appends a non-zero 'other' bucket last, and hides it at zero", () => {
    const { rerender } = renderWithProviders(
      <CategoryDistribution distribution={{ ...FIRST_REAL_REVIEW, other: 3 }} />,
    );
    expect(screen.getByText(categoryLabel("other"))).toBeInTheDocument();

    rerender(
      <CategoryDistribution distribution={{ ...FIRST_REAL_REVIEW, other: 0 }} />,
    );
    expect(screen.queryByText(categoryLabel("other"))).not.toBeInTheDocument();
  });

  it("states what an even spread would be", () => {
    renderWithProviders(<CategoryDistribution distribution={FIRST_REAL_REVIEW} />);

    // 8 comments across 6 categories.
    expect(screen.getByText(/even would be about 1\.3 each/i)).toBeInTheDocument();
  });

  it("gives the svg an accessible label carrying the numbers", () => {
    const { container } = renderWithProviders(
      <CategoryDistribution distribution={FIRST_REAL_REVIEW} />,
    );

    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("role", "img");
    expect(svg.getAttribute("aria-label")).toMatch(/Logic 5/);
    expect(svg.getAttribute("aria-label")).toMatch(/Security 0/);
  });

  it("scales rather than forcing a fixed pixel width", () => {
    const { container } = renderWithProviders(
      <CategoryDistribution distribution={FIRST_REAL_REVIEW} />,
    );

    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("viewBox");
    expect(svg).not.toHaveAttribute("width");
    expect(svg).toHaveClass("w-full");
  });
});

const point = (value: number, index: number): TokenEfficiencyPoint => ({
  review_id: `review-${index}`,
  created_at: `2026-07-2${index}T09:00:00Z`,
  value,
});

describe("TokenEfficiencyTrend", () => {
  /**
   * A line from one point is a decoration that looks like evidence. Three is
   * the fewest that can show a direction rather than a single step.
   */
  it("renders a point rather than a line for a single measurement", () => {
    const { container } = renderWithProviders(
      <TokenEfficiencyTrend points={[point(0.033, 1)]} reviewsCompleted={12} />,
    );

    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });

  /**
   * Being non-NaN is not the same as being visible. A dot placed outside the
   * viewBox is clipped and renders as nothing at all — the same silent
   * failure, one step further along, and exactly how the "Architecture" label
   * on the bar chart went missing at `LABEL_W = 96` with every test green.
   *
   * The single-point case is the one at risk and the one the page is actually
   * in: both of its coordinates come from the degenerate-span guards
   * (`span === 0`, `points.length === 1`) rather than from the data, so
   * nothing about the fixture would reveal them being wrong.
   */
  it("places the single point inside the viewBox, fully within its radius", () => {
    const { container } = renderWithProviders(
      <TokenEfficiencyTrend points={[point(0.033, 1)]} reviewsCompleted={12} />,
    );

    const [, , width, height] = container
      .querySelector("svg")!
      .getAttribute("viewBox")!
      .split(" ")
      .map(Number);
    const dot = container.querySelector("circle")!;
    const cx = Number(dot.getAttribute("cx"));
    const cy = Number(dot.getAttribute("cy"));
    const r = Number(dot.getAttribute("r"));

    expect(Number.isFinite(cx)).toBe(true);
    expect(Number.isFinite(cy)).toBe(true);
    expect(cx).toBeGreaterThanOrEqual(r);
    expect(cx).toBeLessThanOrEqual(width - r);
    expect(cy).toBeGreaterThanOrEqual(r);
    expect(cy).toBeLessThanOrEqual(height - r);
  });

  it("still refuses a line at two points", () => {
    const { container } = renderWithProviders(
      <TokenEfficiencyTrend
        points={[point(0.03, 1), point(0.05, 2)]}
        reviewsCompleted={12}
      />,
    );

    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });

  it("draws a line once there are three points", () => {
    const { container } = renderWithProviders(
      <TokenEfficiencyTrend
        points={[point(0.03, 1), point(0.05, 2), point(0.04, 3)]}
        reviewsCompleted={12}
      />,
    );

    expect(container.querySelector("polyline")).not.toBeNull();
  });

  /**
   * Without this, a three-dot chart reads as "Liffy has run three reviews"
   * when the truth is that only three of twelve have both a token count and
   * a rating.
   */
  it("says how many reviews the series actually covers", () => {
    renderWithProviders(
      <TokenEfficiencyTrend points={[point(0.033, 1)]} reviewsCompleted={12} />,
    );

    expect(screen.getByText(/1 of 12 completed reviews qualifies/i)).toBeInTheDocument();
    expect(screen.getByText(/too few to draw a trend/i)).toBeInTheDocument();
  });

  /** A flat series makes `max - min` zero — the other divide-by-zero here. */
  it("does not produce NaN for a flat series", () => {
    const { container } = renderWithProviders(
      <TokenEfficiencyTrend
        points={[point(0.03, 1), point(0.03, 2), point(0.03, 3)]}
        reviewsCompleted={12}
      />,
    );

    for (const circle of container.querySelectorAll("circle")) {
      expect(circle.getAttribute("cy")).not.toContain("NaN");
    }
    expect(container.querySelector("polyline")!.getAttribute("points")).not.toContain(
      "NaN",
    );
  });

  it("says so plainly when there is nothing to plot", () => {
    const { container } = renderWithProviders(
      <TokenEfficiencyTrend points={[]} reviewsCompleted={12} />,
    );

    expect(screen.getByText(/nothing to plot yet/i)).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("gives the svg an accessible label", () => {
    const { container } = renderWithProviders(
      <TokenEfficiencyTrend points={[point(0.033, 1)]} reviewsCompleted={12} />,
    );

    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("role", "img");
    expect(svg.getAttribute("aria-label")).toMatch(/single measurement of 0\.033/);
  });
});

const severityRows: SeverityCalibrationRow[] = [
  { severity: "critical", comments: 1, prs_with_comment: 1, prs_still_open: 1, still_open_rate: 1 },
  { severity: "warning", comments: 5, prs_with_comment: 4, prs_still_open: 1, still_open_rate: 0.25 },
  { severity: "info", comments: 2, prs_with_comment: 0, prs_still_open: 0, still_open_rate: null },
];

describe("SeverityCalibration", () => {
  /**
   * The one thing that must not appear here is a rate without its n. §8.1
   * calls this a monthly audit precisely because the sample is tiny, and
   * #193 returns `prs_with_comment` for this purpose.
   */
  it("shows the sample size beside every rate", () => {
    renderWithProviders(<SeverityCalibration rows={severityRows} />);

    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("(1 of 4)")).toBeInTheDocument();
    expect(screen.getByText("(1 of 1)")).toBeInTheDocument();
  });

  /**
   * Nothing here shows that Liffy's comment is *why* a pull request is still
   * open, so the data cannot support the words "blocked merge". Asserted
   * rather than trusted, because it is exactly the phrase someone reaches for.
   *
   * The footnote no longer blames GitHub's API for the gap. It never was
   * GitHub's — `merged_at` is on every pull request payload and was simply
   * never read (#279). What the column is honestly limited to is correlation.
   */
  it("never says 'blocked merge'", () => {
    const { container } = renderWithProviders(
      <SeverityCalibration rows={severityRows} />,
    );

    expect(container.textContent?.toLowerCase()).not.toContain("blocked");
    expect(screen.getByText(/correlation, not a measure/i)).toBeInTheDocument();
  });

  /**
   * The old footnote said GitHub's API "does not distinguish merged from
   * closed-without-merging". It does, and always did. A confidently wrong
   * caveat is worse than none: it sent the next reader looking for a limit
   * that was never there and away from the real bug, which was that the
   * status column was never re-synced at all.
   */
  it("does not blame GitHub's API for the limitation", () => {
    const { container } = renderWithProviders(
      <SeverityCalibration rows={severityRows} />,
    );

    expect(container.textContent?.toLowerCase()).not.toContain(
      "does not distinguish",
    );
  });

  /** No PRs at that severity means no rate — an em dash, never 0%. */
  it("renders a null rate as unmeasured rather than as zero", () => {
    renderWithProviders(<SeverityCalibration rows={severityRows} />);

    const info = screen.getByText("Info").closest("tr")!;
    expect(within(info).getByText("—")).toBeInTheDocument();
    expect(within(info).queryByText("0%")).not.toBeInTheDocument();
  });

  it("renders every severity, even at zero", () => {
    renderWithProviders(<SeverityCalibration rows={severityRows} />);

    expect(screen.getByText("Critical")).toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getByText("Info")).toBeInTheDocument();
  });
});

const flagged = (n: number): FlaggedReview[] =>
  Array.from({ length: n }, (_, i) => ({
    review_id: `bbbbbbbb-0000-0000-0000-00000000000${i}`,
    pr_number: 40 + i,
    repo_full_name: "lucenity0/Liffy",
    approval_rate: 0.25,
  }));

describe("FlaggedReviews", () => {
  it("links each flagged review to its detail page", () => {
    renderWithProviders(<FlaggedReviews reviews={flagged(2)} total={2} />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute(
      "href",
      "/reviews/bbbbbbbb-0000-0000-0000-000000000000",
    );
    expect(screen.getAllByText("25% approval")).toHaveLength(2);
  });

  /** A silently truncated list reads as a complete one. */
  it("says how many it is showing when the list is capped", () => {
    renderWithProviders(<FlaggedReviews reviews={flagged(20)} total={34} />);

    expect(screen.getByText(/showing 20 of 34/i)).toBeInTheDocument();
  });

  it("does not claim truncation when the list is complete", () => {
    renderWithProviders(<FlaggedReviews reviews={flagged(3)} total={3} />);

    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument();
  });

  /** Empty is the good outcome, so it reads as reassurance, not absence. */
  it("renders a reassuring empty state", () => {
    renderWithProviders(<FlaggedReviews reviews={[]} total={0} />);

    expect(screen.getByText("Nothing flagged.")).toBeInTheDocument();
    expect(screen.getByText(/no review has scored below 50%/i)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  /**
   * An empty list meaning "the weekly job hasn't run" and one meaning
   * "nothing is wrong" look identical, so the page says which it could be.
   */
  it("discloses that flags come from the weekly job", () => {
    renderWithProviders(<FlaggedReviews reviews={[]} total={0} />);

    expect(screen.getByText(/weekly evaluation job/i)).toBeInTheDocument();
  });
});
