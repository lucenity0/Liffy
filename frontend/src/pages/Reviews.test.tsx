import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import {
  fixtureRepoIndexed,
  fixtureRepoIndexing,
  fixtureReviewListItems,
  reviewPage,
} from "@/mocks/fixtures";
import { REVIEWS_PAGE_SIZE } from "@/hooks/useReviews";
import { formatCount } from "@/lib/utils";
import type { ReviewListItem } from "@/types/api";
import { renderWithProviders } from "@/test/renderWithProviders";
import { parseOffset, parseReviewFilters } from "@/lib/pagination";
import { Reviews } from "./Reviews";

/**
 * How many rows the tracked stub pretends to hold. Comfortably more than the
 * two pages any test here walks, so `hasNextPage` stays true throughout —
 * that used to be implied by returning a full page, and is now stated,
 * because the hook reads a real total instead of guessing from page length.
 */
const TRACKED_TOTAL = 100;

/** A full page of distinct rows. */
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
      return HttpResponse.json(reviewPage(pageFor(offset), TRACKED_TOTAL));
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

describe("URL filter parsing", () => {
  it.each([
    ["?pr=abc", "pr"],
    ["?pr=1e3", "pr"],
    ["?pr=-4", "pr"],
    ["?status=banana", "status"],
    ["?repo=not-a-uuid", "repo"],
  ])("degrades %s to no filter rather than sending it", (query, param) => {
    const filters = parseReviewFilters(new URLSearchParams(query));
    const key = { pr: "prNumber", status: "status", repo: "repoId" }[param]!;
    expect(filters[key as keyof typeof filters]).toBeUndefined();
  });

  it("falls back to newest for an unreadable sort, since a list is always ordered", () => {
    expect(parseReviewFilters(new URLSearchParams("?sort=sideways")).sort).toBe(
      "newest",
    );
  });

  it("reads a well-formed set", () => {
    const filters = parseReviewFilters(
      new URLSearchParams(
        `?repo=${fixtureRepoIndexed.id}&pr=203&status=failed&sort=oldest`,
      ),
    );
    expect(filters).toEqual({
      repoId: fixtureRepoIndexed.id,
      prNumber: 203,
      status: "failed",
      sort: "oldest",
    });
  });
});

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
        return HttpResponse.json(reviewPage(fullPage(offset), TRACKED_TOTAL));
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
    server.use(http.get("*/reviews", () => HttpResponse.json(reviewPage([]))));

    renderPage();

    expect(await screen.findByText(/nothing reviewed yet/i)).toBeInTheDocument();
  });

  it("shows a different empty state when you page past the end", async () => {
    server.use(http.get("*/reviews", () => HttpResponse.json(reviewPage([]))));

    renderPage("/reviews?offset=40");

    expect(await screen.findByText(/nothing on this page/i)).toBeInTheDocument();
    // Previous is the way out, so it must still be live.
    expect(screen.getByRole("button", { name: /previous/i })).toBeEnabled();
  });

  it("offers the trigger form from the header and from the empty state", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/reviews", () => HttpResponse.json(reviewPage([]))));

    renderPage();
    await screen.findByText(/nothing reviewed yet/i);

    // The empty-state CTA and the header button open the same modal.
    await user.click(screen.getByRole("button", { name: /review a pull request/i }));
    expect(
      await screen.findByRole("dialog", { name: /review a pull request/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "New review" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("queues a review, returns to page one, and says where it will appear", async () => {
    const user = userEvent.setup();
    trackPages(fullPage);
    server.use(
      http.post("*/reviews/trigger", () =>
        HttpResponse.json(
          { status: "queued", repo: "lucenity0/Liffy", pr_number: 58 },
          { status: 202 },
        ),
      ),
    );

    renderPage("/reviews?offset=20");
    await screen.findByRole("list", { name: "Reviews" });

    await user.click(screen.getByRole("button", { name: "New review" }));
    await user.type(
      screen.getByRole("textbox", { name: /repository/i }),
      "lucenity0/Liffy",
    );
    await user.type(screen.getByRole("textbox", { name: /pull request/i }), "58");
    await user.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The 202 has no review id, so there is nothing to deep-link to — the new
    // row is the newest, and page three is not where it lands. Waited for
    // rather than asserted outright: the router commits the navigation on its
    // own schedule, not necessarily in the same paint as the modal closing.
    await waitFor(() => expect(searchString()).toBe(""));
    expect(await screen.findByRole("status")).toHaveTextContent(/queued/i);
    expect(screen.getByRole("status")).toHaveTextContent("58");
  });

  it("puts a chosen repo in the URL and refetches for it", async () => {
    const user = userEvent.setup();
    const asked: (string | null)[] = [];
    server.use(
      http.get("*/reviews", ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("repo_id"));
        return HttpResponse.json(reviewPage(fixtureReviewListItems));
      }),
    );

    renderPage();
    await screen.findByRole("list", { name: "Reviews" });

    await user.selectOptions(
      screen.getByRole("combobox", { name: /repository/i }),
      fixtureRepoIndexed.id,
    );

    await waitFor(() => expect(searchString()).toBe(`?repo=${fixtureRepoIndexed.id}`));
    await waitFor(() => expect(asked).toContain(fixtureRepoIndexed.id));
  });

  it("returns to page one when a filter changes", async () => {
    const user = userEvent.setup();
    trackPages(fullPage);

    renderPage("/reviews?offset=40");
    await screen.findByRole("list", { name: "Reviews" });

    await user.selectOptions(
      screen.getByRole("combobox", { name: /repository/i }),
      fixtureRepoIndexing.id,
    );

    // The trap: staying on offset 40 while switching to a repo with three
    // reviews renders "You have paged past the end", which is reached by an
    // ordinary click and is indistinguishable from a bug.
    await waitFor(() =>
      expect(searchString()).toBe(`?repo=${fixtureRepoIndexing.id}`),
    );
  });

  it("keeps the sort in the URL and asks for it", async () => {
    const user = userEvent.setup();
    const asked: (string | null)[] = [];
    server.use(
      http.get("*/reviews", ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("sort"));
        return HttpResponse.json(reviewPage(fixtureReviewListItems));
      }),
    );

    renderPage();
    await screen.findByRole("list", { name: "Reviews" });

    await user.selectOptions(
      screen.getByRole("combobox", { name: /order/i }),
      "oldest",
    );

    await waitFor(() => expect(searchString()).toBe("?sort=oldest"));
    await waitFor(() => expect(asked).toContain("oldest"));
  });

  it("renders page one for garbage in the URL rather than erroring", async () => {
    renderPage("/reviews?pr=abc&status=banana&repo=nonsense");

    // Rendered, not 422'd: every unreadable value degrades to no filter before
    // it can reach the API.
    await screen.findByRole("list", { name: "Reviews" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(rows()).toHaveLength(fixtureReviewListItems.length);
    // And nothing claims to be filtering, so there is no phantom Clear button.
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
  });

  it("clears every filter and returns to the unfiltered list", async () => {
    const user = userEvent.setup();

    renderPage(`/reviews?repo=${fixtureRepoIndexed.id}&status=failed&sort=oldest`);
    await screen.findByRole("list", { name: "Reviews" });

    await user.click(screen.getByRole("button", { name: /clear filters/i }));

    await waitFor(() => expect(searchString()).toBe(""));
    expect(
      screen.queryByRole("button", { name: /clear filters/i }),
    ).toBeNull();
  });

  it("distinguishes empty-because-filtered from empty-because-nothing", async () => {
    server.use(http.get("*/reviews", () => HttpResponse.json(reviewPage([]))));

    const { unmount } = renderPage("/reviews?status=failed");
    // "Nothing reviewed yet." would be both wrong and alarming here — the
    // reviews exist, they just do not match.
    expect(
      await screen.findByText(/no reviews match these filters/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/nothing reviewed yet/i)).toBeNull();
    unmount();

    renderPage();
    expect(await screen.findByText(/nothing reviewed yet/i)).toBeInTheDocument();
  });

  it("settles the PR number box on the number that was typed", async () => {
    const user = userEvent.setup();
    const asked: (string | null)[] = [];
    server.use(
      http.get("*/reviews", ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("pr_number"));
        return HttpResponse.json(reviewPage(fixtureReviewListItems));
      }),
    );

    renderPage();
    await screen.findByRole("list", { name: "Reviews" });

    await user.type(screen.getByRole("textbox", { name: /pr number/i }), "203");

    await waitFor(() => expect(searchString()).toBe("?pr=203"));
    // Asserts where it lands, not how many requests it took to get there:
    // whether a keystroke outruns the debounce depends on how loaded the
    // machine is, and a test that fails on a busy CI box is not evidence of
    // anything. The collapsing itself is `useDebouncedValue`'s own test,
    // where fake timers make it deterministic.
    expect(asked.at(-1)).toBe("203");
  });

  it("does not send a half-typed PR number that is not a number", async () => {
    const user = userEvent.setup();

    renderPage();
    await screen.findByRole("list", { name: "Reviews" });

    await user.type(screen.getByRole("textbox", { name: /pr number/i }), "abc");

    expect(await screen.findByText(/digits only/i)).toBeInTheDocument();
    // The URL stays clean, so a refresh does not resurrect the bad value.
    await waitFor(() => expect(searchString()).toBe(""));
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
