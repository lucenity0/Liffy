import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import { fixtureReviewListItems } from "@/mocks/fixtures";
import { REVIEWS_PAGE_SIZE } from "@/hooks/useReviews";
import { formatCount } from "@/lib/utils";
import type { ReviewListItem } from "@/types/api";
import { renderWithProviders } from "@/test/renderWithProviders";
import { parseOffset } from "@/lib/pagination";
import { Reviews } from "./Reviews";

/** A full page of distinct rows, so `hasNextPage` reads true. */
const fullPage = (offset: number): ReviewListItem[] =>
  Array.from({ length: REVIEWS_PAGE_SIZE }, (_, i) => ({
    ...fixtureReviewListItems[0],
    id: `page-${offset}-row-${i}`,
    pr_number: offset + i + 1,
  }));

/** Records every offset the API is asked for, in order. */
function trackPages(pageFor: (offset: number) => ReviewListItem[]) {
  const asked: number[] = [];
  server.use(
    http.get("*/reviews", ({ request }) => {
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      asked.push(offset);
      return HttpResponse.json(pageFor(offset));
    }),
  );
  return asked;
}

const rows = () =>
  within(screen.getByRole("list", { name: "Reviews" })).getAllByRole("listitem");

/**
 * MemoryRouter never touches window.location, so the URL contract has to be
 * read back through the router itself.
 */
function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

const searchString = () => screen.getByTestId("search").textContent;

function renderPage(route = "/reviews") {
  return renderWithProviders(
    <>
      <Reviews />
      <LocationProbe />
    </>,
    { route },
  );
}

describe("parseOffset", () => {
  it.each([
    [null, 0],
    ["", 0],
    ["0", 0],
    ["20", 20],
    ["-40", 0],
    ["abc", 0],
    ["NaN", 0],
    ["1e309", 0],
    // Snapped to a page boundary, so Previous/Next stay on the same grid.
    ["25", 20],
    ["19", 0],
  ])("%j → %i", (raw, expected) => {
    expect(parseOffset(raw)).toBe(expected);
  });
});

describe("Reviews", () => {
  it("renders one detailed row per review, linking to its detail route", async () => {
    renderPage();

    await screen.findByRole("list", { name: "Reviews" });
    expect(rows()).toHaveLength(fixtureReviewListItems.length);

    const completed = fixtureReviewListItems.find((r) => r.summary)!;
    const row = rows().find((r) => within(r).queryByText(completed.summary!))!;
    expect(within(row).getByRole("link")).toHaveAttribute(
      "href",
      `/reviews/${completed.id}`,
    );
    // The detailed variant adds what the dashboard's compact row leaves out.
    expect(within(row).getByText(/gpt-4o/)).toBeInTheDocument();
    expect(
      within(row).getByText(formatCount(completed.tokens_used!)),
    ).toBeInTheDocument();
  });

  it("tints the failed row and leaves the others alone", async () => {
    renderPage();
    await screen.findByRole("list", { name: "Reviews" });

    const failed = fixtureReviewListItems.find((r) => r.status === "failed")!;
    const failedRow = rows().find((r) =>
      within(r).queryByText(String(failed.pr_number)),
    )!;
    expect(within(failedRow).getByRole("link").className).toContain(
      "bg-oxide-tint",
    );

    const other = rows().find((r) => within(r).queryByText("Approve"))!;
    expect(within(other).getByRole("link").className).not.toContain(
      "bg-oxide-tint",
    );
  });

  it("reads the starting page out of the URL", async () => {
    const asked = trackPages(fullPage);

    renderPage("/reviews?offset=20");

    await screen.findByRole("list", { name: "Reviews" });
    expect(asked).toEqual([20]);
    expect(screen.getByLabelText("Pagination")).toHaveTextContent("21–40");
  });

  it("Next advances the URL and asks the API for the next offset", async () => {
    const user = userEvent.setup();
    const asked = trackPages(fullPage);

    renderPage();
    await screen.findByRole("list", { name: "Reviews" });

    await user.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => expect(asked).toEqual([0, REVIEWS_PAGE_SIZE]));
    expect(searchString()).toBe("?offset=20");
  });

  it("Previous goes back, and drops the param entirely at the first page", async () => {
    const user = userEvent.setup();
    trackPages(fullPage);

    renderPage("/reviews?offset=20");
    await screen.findByRole("list", { name: "Reviews" });

    await user.click(screen.getByRole("button", { name: /previous/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("Pagination")).toHaveTextContent("1–20"),
    );
    // Not "?offset=0" — the first page is the bare URL.
    expect(searchString()).toBe("");
  });

  it("disables Previous on the first page and Next on a short one", async () => {
    renderPage();
    await screen.findByRole("list", { name: "Reviews" });

    // 4 fixtures against a page size of 20 — first page, and definitely last.
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("keeps the previous page on screen while the next one loads", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    server.use(
      http.get("*/reviews", async ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        if (offset > 0) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return HttpResponse.json(fullPage(offset));
      }),
    );

    renderPage();
    await screen.findByRole("list", { name: "Reviews" });

    await user.click(screen.getByRole("button", { name: /next/i }));

    // Mid-flight: rows are still there rather than flashing to a skeleton.
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(rows()).toHaveLength(REVIEWS_PAGE_SIZE);

    release?.();
    await waitFor(() =>
      expect(screen.getByLabelText("Pagination")).toHaveTextContent("21–40"),
    );
  });

  it("shows the first-run empty state at offset 0", async () => {
    server.use(http.get("*/reviews", () => HttpResponse.json([])));

    renderPage();

    expect(await screen.findByText(/nothing reviewed yet/i)).toBeInTheDocument();
  });

  it("shows a different empty state when you page past the end", async () => {
    server.use(http.get("*/reviews", () => HttpResponse.json([])));

    renderPage("/reviews?offset=40");

    expect(await screen.findByText(/nothing on this page/i)).toBeInTheDocument();
    // Previous is the way out, so it must still be live.
    expect(screen.getByRole("button", { name: /previous/i })).toBeEnabled();
  });

  it("surfaces a failed page", async () => {
    server.use(
      http.get("*/reviews", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
