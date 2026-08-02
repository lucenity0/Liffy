import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server } from "@/mocks/server";
import { renderWithProviders } from "@/test/renderWithProviders";
import { Help } from "./Help";

const renderPage = (route = "/help") => renderWithProviders(<Help />, { route });

/**
 * The reading pane, as a landmark. Scoped queries matter here: the list pane
 * shows a snippet of the same page, so an unscoped match for body text is
 * ambiguous between "the answer is shown" and "the answer is merely listed".
 */
const answer = async () => await screen.findByRole("region", { name: "Answer" });

describe("Help", () => {
  it("offers common questions before anything is typed", async () => {
    renderPage();

    expect(await screen.findByText("Queued vs processing")).toBeInTheDocument();
    // The right pane explains itself rather than sitting blank.
    expect(screen.getByText("How this works")).toBeInTheDocument();
  });

  it("says plainly that it is not an AI", async () => {
    /**
     * Load-bearing copy, not decoration. The only reason an answer here can be
     * trusted is that nothing generated it, and a help surface that looks like
     * a chat box invites exactly the question this feature cannot answer.
     */
    renderPage();

    expect(
      await screen.findByText(/not an AI — it returns written answers/i),
    ).toBeInTheDocument();
  });

  it("searches and shows the top passage in the reading pane", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Queued vs processing");

    await user.type(
      screen.getByLabelText(/search liffy's documentation/i),
      "queued",
    );

    // The passage body, not just the title — the reading pane shows the page.
    await waitFor(async () =>
      expect(await answer()).toHaveTextContent(/until a worker picks it up/i),
    );
  });

  it("puts the query in the URL so an answer can be linked", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Queued vs processing");

    await user.type(screen.getByLabelText(/search liffy's documentation/i), "queued");

    // MemoryRouter holds the URL internally, so the observable contract is the
    // one that matters to a shared link: a query supplied *through* the URL
    // renders its answer without anyone typing.
    cleanup();
    renderPage("/help?q=queued");
    await waitFor(async () =>
      expect(await answer()).toHaveTextContent(/until a worker picks it up/i),
    );
  });

  it("renders a passage from a deep link, which is what the failed-review panel uses", async () => {
    renderPage("/help?q=queued&page=review-failed");

    // `review-failed` does not rank for "queued" — the page must still be the
    // one the link names, not whatever came top.
    await waitFor(async () =>
      expect(await answer()).toHaveTextContent(/the reason is recorded on the review itself/i),
    );
  });

  it("says nothing matched instead of showing the closest miss", async () => {
    /**
     * The floor firing is the whole trust story. A help box that always
     * produces *something* is one that answers questions it cannot answer, so
     * the empty result has to render as a deliberate answer rather than as an
     * error or an empty list.
     */
    server.use(
      http.get("*/help", ({ request }) =>
        HttpResponse.json({
          query: new URL(request.url).searchParams.get("q") ?? "",
          results: [],
        }),
      ),
    );
    renderPage("/help?q=how%20do%20i%20deploy%20to%20kubernetes");

    expect(await screen.findByText("Nothing matched")).toBeInTheDocument();
    expect(screen.getByText(/don't cover/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("moves between passages through the related links", async () => {
    const user = userEvent.setup();
    renderPage("/help?q=queued");

    await waitFor(async () =>
      expect(await answer()).toHaveTextContent(/until a worker picks it up/i),
    );
    await user.click(
      within(await answer()).getByRole("button", { name: "Why a review failed" }),
    );

    await waitFor(async () =>
      expect(await answer()).toHaveTextContent(/the reason is recorded on the review itself/i),
    );
  });
});

describe("Help — reporting a problem", () => {
  it("routes a security report to the private advisory form, carrying no detail", async () => {
    /**
     * SECURITY.md is explicit: a public issue is readable by everyone,
     * including whoever would use the bug, before there is a fix. So the
     * security branch must not open an issue — and must not put the
     * description in a URL either, where it would land in browser history and
     * a referrer header.
     */
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Queued vs processing");

    await user.click(screen.getByRole("button", { name: /report a problem/i }));
    await user.click(screen.getByLabelText(/security vulnerability/i));
    await user.click(screen.getByRole("button", { name: /private advisory form/i }));

    const url = open.mock.calls[0][0] as string;
    expect(url).toBe("https://github.com/lucenity0/Liffy/security/advisories/new");
    expect(url).not.toContain("issues/new");
    expect(url).not.toContain("body=");
    open.mockRestore();
  });

  it("prefills a normal issue with context and lets the reporter submit it", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    renderPage("/help?q=queued");
    await screen.findByRole("button", { name: /report a problem/i });

    await user.click(screen.getByRole("button", { name: /report a problem/i }));
    await user.type(
      screen.getByLabelText(/what went wrong/i),
      "Reviews stay queued forever",
    );
    await user.click(screen.getByRole("button", { name: /prefilled issue/i }));

    const url = decodeURIComponent(open.mock.calls[0][0] as string);
    expect(url).toContain("github.com/lucenity0/Liffy/issues/new");
    expect(url).toContain("Reviews stay queued forever");
    expect(url).toContain("Searched help for");
    // Liffy never files it — the reporter does, under their own account.
    expect(
      screen.getByText(/nothing is filed until you submit it there/i),
    ).toBeInTheDocument();
    open.mockRestore();
  });

  it("never puts a credential in a report", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Queued vs processing");

    await user.click(screen.getByRole("button", { name: /report a problem/i }));
    await user.click(screen.getByRole("button", { name: /prefilled issue/i }));

    const url = decodeURIComponent(open.mock.calls[0][0] as string);
    for (const marker of ["sk-ant-", "ghp_", "token", "secret", "password"]) {
      expect(url.toLowerCase()).not.toContain(marker);
    }
    open.mockRestore();
  });
});
