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
} from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import { Dashboard } from "./Dashboard";

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
      fixtureReviewListItems.length,
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
        repos = [...repos, created];
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
    expect(rows).toHaveLength(fixtureReviewListItems.length);

    const first = fixtureReviewListItems[0];
    expect(within(rows[0]).getByRole("link")).toHaveAttribute(
      "href",
      `/reviews/${first.id}`,
    );
    expect(within(rows[0]).getByText(String(first.pr_number))).toBeInTheDocument();
  });

  it("asks for exactly five", async () => {
    let requestedLimit: string | null = null;
    server.use(
      http.get("*/reviews", ({ request }) => {
        requestedLimit = new URL(request.url).searchParams.get("limit");
        return HttpResponse.json(fixtureReviewListItems.slice(0, 5));
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

    // Fixture order: failed (no verdict), processing, approve, request_changes.
    expect(within(rows[0]).getByText("Failed")).toBeInTheDocument();
    expect(within(rows[0]).queryByText("Approve")).toBeNull();
    expect(within(rows[2]).getByText("Approve")).toBeInTheDocument();
  });

  it("has its own empty state", async () => {
    server.use(http.get("*/reviews", () => HttpResponse.json([])));

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
