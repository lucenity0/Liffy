import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import {
  fixtureRepoIndexed,
  fixtureRepoIndexing,
  fixtureRepoStatusIndexed,
  fixtureRepoStatusNotIndexed,
  fixtureRepos,
  fixtureReviewListItems,
  reviewPage,
} from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import { Dashboard } from "./Dashboard";

/**
 * The dashboard asks for `include_failed=false`, so a failed fixture row never
 * reaches it. Derived from the fixtures rather than hardcoded, so adding one
 * does not quietly break the counts below.
 */
const visibleReviews = fixtureReviewListItems.filter((r) => r.status !== "failed");

/**
 * Every repo query is scoped to the repositories list. It has to be: a repo's
 * full_name also appears in the review rows below it, and testing-library
 * matches on an element's *direct* text nodes — so an unscoped
 * `getByText("lucenity0/Liffy")` matches the card and three review rows, and
 * which of those has rendered first is a race.
 */
function reposList() {
  return screen.findByRole("list", { name: "Repositories" });
}

async function repoCard(fullName: string) {
  const list = await reposList();
  const card = within(list)
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText(fullName));

  if (!card) throw new Error(`No repo card for ${fullName}`);
  return card;
}

describe("Dashboard — repositories", () => {
  it("renders a card per repo with its index status and chunk count", async () => {
    renderWithProviders(<Dashboard />);

    const card = await repoCard(fixtureRepoIndexed.full_name);

    // The chip and count arrive on the status call, one tick after the card.
    expect(await within(card).findByText("Indexed")).toBeInTheDocument();
    expect(
      within(card).getByText(String(fixtureRepoStatusIndexed.chunk_count)),
    ).toBeInTheDocument();
    // The branch comes from GET /repos instead — two sources, one card.
    expect(
      within(card).getByText(fixtureRepoIndexed.default_branch),
    ).toBeInTheDocument();
  });

  it("shows the in-flight state for a repo that is still indexing", async () => {
    renderWithProviders(<Dashboard />);

    const card = await repoCard(fixtureRepoIndexing.full_name);

    expect(await within(card).findByText("Indexing")).toBeInTheDocument();
    expect(within(card).getByText(/building the index/i)).toBeInTheDocument();
    // A repo mid-index has no chunk count worth showing.
    expect(
      within(card).queryByText(String(fixtureRepoStatusNotIndexed.chunk_count)),
    ).toBeNull();
  });

  it("falls back to the list's indexed_at when the status request fails", async () => {
    server.use(
      http.get("*/repos/:repoId/status", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    renderWithProviders(<Dashboard />);

    const card = await repoCard(fixtureRepoIndexed.full_name);

    // indexed_at is non-null on this fixture, so the chip still reads Indexed
    // — only the chunk count is lost.
    expect(await within(card).findByText("Indexed")).toBeInTheDocument();
    expect(within(card).getByText(/status unavailable/i)).toBeInTheDocument();
  });

  it("offers an empty state when nothing is connected", async () => {
    server.use(http.get("*/repos", () => HttpResponse.json([])));

    renderWithProviders(<Dashboard />);

    expect(await screen.findByText(/no repositories yet/i)).toBeInTheDocument();
  });

  it("surfaces a failed repos query without taking the reviews down with it", async () => {
    server.use(
      http.get("*/repos", () =>
        HttpResponse.json({ detail: "no token" }, { status: 503 }),
      ),
    );

    renderWithProviders(<Dashboard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no GitHub token configured/i,
    );
    // The other section runs off its own query and is unaffected.
    const reviews = await screen.findByRole("list", { name: "Recent reviews" });
    expect(within(reviews).getAllByRole("listitem")).toHaveLength(
      visibleReviews.length,
    );
  });

  it("opens the connect modal from the section header", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Dashboard />);

    await user.click(
      await screen.findByRole("button", { name: "Connect repository" }),
    );

    expect(
      await screen.findByRole("dialog", { name: /connect a repository/i }),
    ).toBeInTheDocument();
  });

  it("connects a repo and lands the new card in the list", async () => {
    const user = userEvent.setup();

    // The card only appears if the mutation's invalidation actually refetches
    // the list — so the handler has to grow a repo, not just return one.
    let repos = [...fixtureRepos];
    server.use(
      http.get("*/repos", () => HttpResponse.json(repos)),
      http.post("*/repos", async ({ request }) => {
        const { full_name } = (await request.json()) as { full_name: string };
        const created = {
          id: "99999999-9999-9999-9999-999999999999",
          full_name,
          default_branch: "main",
          indexed_at: null,
          created_at: "2026-07-26T10:00:00Z",
        };
        // The list computes the review history; POST does not return it. The
        // split is real — see RepoListItemOut — so the mock keeps it, and a
        // page reading counts off a connect response fails here.
        repos = [...repos, { ...created, review_count: 0, last_review_at: null }];
        return HttpResponse.json(created, { status: 201 });
      }),
    );

    renderWithProviders(<Dashboard />);

    await user.click(
      await screen.findByRole("button", { name: "Connect repository" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: /repository/i }),
      "lucenity0/dotfiles",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const card = await repoCard("lucenity0/dotfiles");
    // Fresh repos are never indexed yet, so the poll starts on arrival.
    expect(await within(card).findByText("Indexing")).toBeInTheDocument();
  });
});

describe("Dashboard — repo actions", () => {
  it("re-indexes on click and confirms the 202 inline", async () => {
    const user = userEvent.setup();
    let indexCalls = 0;
    let indexing = false;
    server.use(
      http.post("*/repos/:repoId/index", ({ params }) => {
        indexCalls += 1;
        indexing = true;
        return HttpResponse.json(
          { repo_id: params.repoId, status: "queued" },
          { status: 202 },
        );
      }),
      http.get("*/repos/:repoId/status", ({ params }) =>
        params.repoId === fixtureRepoIndexed.id && indexing
          ? HttpResponse.json({
              ...fixtureRepoStatusIndexed,
              status: "not_indexed",
              indexed_at: null,
            })
          : params.repoId === fixtureRepoIndexed.id
            ? HttpResponse.json(fixtureRepoStatusIndexed)
            : HttpResponse.json(fixtureRepoStatusNotIndexed),
      ),
    );

    renderWithProviders(<Dashboard />);

    const card = await repoCard(fixtureRepoIndexed.full_name);
    await user.click(within(card).getByRole("button", { name: "Re-index" }));

    expect(await within(card).findByText(/re-index queued/i)).toBeInTheDocument();
    expect(await within(card).findByText("Indexing")).toBeInTheDocument();
    expect(indexCalls).toBe(1);
    // Mutation state is per card, so nothing else claims to be re-indexing.
    const other = await repoCard(fixtureRepoIndexing.full_name);
    expect(within(other).queryByText(/re-index queued/i)).toBeNull();
  });

  it("reports a failed re-index on the card instead of silently doing nothing", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/repos/:repoId/index", () =>
        HttpResponse.json({ detail: "no token" }, { status: 503 }),
      ),
    );

    renderWithProviders(<Dashboard />);

    const card = await repoCard(fixtureRepoIndexed.full_name);
    await user.click(within(card).getByRole("button", { name: "Re-index" }));

    expect(
      await within(card).findByText(/no GitHub token configured/i),
    ).toBeInTheDocument();
  });

  it("confirms before disconnecting, then drops the card", async () => {
    const user = userEvent.setup();

    // Stateful handlers: the point is that the refetch triggered by the
    // mutation genuinely comes back one repo shorter.
    let repos = [...fixtureRepos];
    let deleted: string | null = null;
    server.use(
      http.get("*/repos", () => HttpResponse.json(repos)),
      http.delete("*/repos/:repoId", ({ params }) => {
        deleted = params.repoId as string;
        repos = repos.filter((repo) => repo.id !== deleted);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderWithProviders(<Dashboard />);

    const card = await repoCard(fixtureRepoIndexing.full_name);
    await user.click(within(card).getByRole("button", { name: "Disconnect" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(fixtureRepoIndexing.full_name);

    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Repositories" })).getAllByRole(
          "listitem",
        ),
      ).toHaveLength(1),
    );
    expect(deleted).toBe(fixtureRepoIndexing.id);
    // The repo that was not confirmed on is the one still standing.
    const survivor = await repoCard(fixtureRepoIndexed.full_name);
    expect(survivor).toBeInTheDocument();
  });

  it("cancelling the confirm leaves the repo alone", async () => {
    const user = userEvent.setup();
    let deleteCalls = 0;
    server.use(
      http.delete("*/repos/:repoId", () => {
        deleteCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderWithProviders(<Dashboard />);

    const card = await repoCard(fixtureRepoIndexing.full_name);
    await user.click(within(card).getByRole("button", { name: "Disconnect" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deleteCalls).toBe(0);
    expect(
      within(await reposList()).getAllByRole("listitem"),
    ).toHaveLength(fixtureRepos.length);
  });
});

describe("Dashboard — recent reviews", () => {
  it("lists the recent reviews, each linking to its detail route", async () => {
    renderWithProviders(<Dashboard />);

    const reviews = await screen.findByRole("list", { name: "Recent reviews" });
    const rows = within(reviews).getAllByRole("listitem");
    expect(rows).toHaveLength(visibleReviews.length);

    // Newest first, by `created_at` — not the fixture array's own order, which
    // is arbitrary and no longer what the handler replays.
    const [newest] = [...visibleReviews].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );
    expect(within(rows[0]).getByRole("link")).toHaveAttribute(
      "href",
      `/reviews/${newest.id}`,
    );
    expect(within(rows[0]).getByText(String(newest.pr_number))).toBeInTheDocument();
  });

  it("asks for exactly five", async () => {
    let requestedLimit: string | null = null;
    server.use(
      http.get("*/reviews", ({ request }) => {
        requestedLimit = new URL(request.url).searchParams.get("limit");
        return HttpResponse.json(reviewPage(fixtureReviewListItems.slice(0, 5)));
      }),
    );

    renderWithProviders(<Dashboard />);

    await screen.findByRole("list", { name: "Recent reviews" });
    expect(requestedLimit).toBe("5");
  });

  it("shows a status badge and, when there is one, a verdict", async () => {
    renderWithProviders(<Dashboard />);

    const reviews = await screen.findByRole("list", { name: "Recent reviews" });
    const rows = within(reviews).getAllByRole("listitem");

    // Newest first, which the handler genuinely sorts by rather than replaying
    // the fixture array's own order: processing (26th), completed (25th),
    // approve (24th). The failed row (23rd) is filtered out before it gets
    // here — see the dedicated test below.
    expect(within(rows[0]).getByText("Processing")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Approve")).toBeInTheDocument();
  });

  it("leaves failed reviews off the dashboard entirely", async () => {
    renderWithProviders(<Dashboard />);

    const reviews = await screen.findByRole("list", { name: "Recent reviews" });
    expect(within(reviews).queryByText("Failed")).toBeNull();
  });

  it("asks the server to exclude them rather than filtering after the fact", async () => {
    // Filtering client-side would leave `total` counting rows the page does
    // not show, and would spend part of the five-row window on hidden ones.
    let param: string | null = null;
    server.use(
      http.get("*/reviews", ({ request }) => {
        param = new URL(request.url).searchParams.get("include_failed");
        return HttpResponse.json(reviewPage(visibleReviews));
      }),
    );

    renderWithProviders(<Dashboard />);

    await screen.findByRole("list", { name: "Recent reviews" });
    expect(param).toBe("false");
  });

  it("has its own empty state", async () => {
    server.use(http.get("*/reviews", () => HttpResponse.json(reviewPage([]))));

    renderWithProviders(<Dashboard />);

    expect(await screen.findByText(/nothing reviewed yet/i)).toBeInTheDocument();
  });

  it("has its own error state", async () => {
    server.use(
      http.get("*/reviews", () =>
        HttpResponse.json({ detail: "nope" }, { status: 500 }),
      ),
    );

    renderWithProviders(<Dashboard />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("nope");
    expect(alert).toHaveTextContent("HTTP 500");
    // Repositories are untouched.
    expect(
      within(await reposList()).getAllByRole("listitem"),
    ).toHaveLength(fixtureRepos.length);
  });
});

describe("Dashboard — this week", () => {
  it("opens with figures that exist nowhere else on the page", async () => {
    renderWithProviders(<Dashboard />);

    const strip = await screen.findByRole("region", { name: "This week" });

    // The region mounts with skeletons in it, so the figures are awaited.
    expect(await within(strip).findByText("5")).toBeInTheDocument();
    expect(within(strip).getByText("18")).toBeInTheDocument();
    // Repositories *active* this week — two, while the fixture list has two
    // connected. Different questions that happen to agree here.
    expect(within(strip).getByText("Findings")).toBeInTheDocument();
  });

  it("says zero rather than a dash when nothing happened", async () => {
    server.use(
      http.get("*/analytics/activity", () =>
        HttpResponse.json({ days: 7, reviews: 0, findings: 0, repositories: 0 }),
      ),
    );

    renderWithProviders(<Dashboard />);

    const strip = await screen.findByRole("region", { name: "This week" });
    // A quiet week is a measurement, unlike the analytics rates where "no
    // data" and "zero" are genuinely different facts.
    await waitFor(() =>
      expect(within(strip).getAllByText("0")).toHaveLength(3),
    );
  });

  it("titles itself from the window the server answered with", async () => {
    server.use(
      http.get("*/analytics/activity", () =>
        HttpResponse.json({ days: 30, reviews: 9, findings: 40, repositories: 3 }),
      ),
    );

    renderWithProviders(<Dashboard />);

    // Not "This week" — a heading contradicting its own data is a bug that
    // looks entirely fine on screen.
    expect(
      await screen.findByRole("region", { name: "Last 30 days" }),
    ).toBeInTheDocument();
  });

  it("keeps a failed strip from taking the rest of the page with it", async () => {
    server.use(
      http.get("*/analytics/activity", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    renderWithProviders(<Dashboard />);

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(await repoCard(fixtureRepoIndexed.full_name)).toBeInTheDocument();
  });
});

describe("Dashboard — top repositories", () => {
  it("ranks by most recently reviewed, never-reviewed last", async () => {
    server.use(
      http.get("*/repos", () =>
        HttpResponse.json([
          // Connected most recently, but nothing has ever reviewed it.
          { ...fixtureRepoIndexing, review_count: 0, last_review_at: null },
          { ...fixtureRepoIndexed, last_review_at: "2026-07-26T14:12:00Z" },
        ]),
      ),
    );

    renderWithProviders(<Dashboard />);

    const list = await reposList();
    const names = within(list)
      .getAllByRole("listitem")
      .map((item) => within(item).getAllByRole("link")[0].textContent);

    // `null` sorts last as "never", not first as "unknown, possibly recent" —
    // otherwise a brand-new connection outranks active work every time.
    expect(names).toEqual([
      fixtureRepoIndexed.full_name,
      fixtureRepoIndexing.full_name,
    ]);
  });

  it("does not carry the same name as the Repositories page", async () => {
    renderWithProviders(<Dashboard />);

    // Two nav destinations reading "Repositories" was half of why the
    // dashboard looked like a copy of the page it links to.
    expect(await screen.findByText("Top repositories")).toBeInTheDocument();
    // Awaited: the link only exists once there is a list to link past, so it
    // arrives with the repos rather than with the header.
    expect(
      await screen.findByRole("link", { name: "All repositories →" }),
    ).toHaveAttribute("href", "/repositories");
  });
});
