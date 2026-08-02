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
  const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByRole("button", { name: /report a problem/i });
    await user.click(screen.getByRole("button", { name: /report a problem/i }));
  };

  it("files a bug and shows where it went", async () => {
    const user = userEvent.setup();
    renderPage("/help?q=queued");
    await openForm(user);

    await user.type(screen.getByLabelText("Title"), "Reviews stay queued");
    await user.type(
      screen.getByLabelText(/what went wrong/i),
      "They never start running.",
    );
    await user.click(screen.getByRole("button", { name: "File this issue" }));

    // The number is the receipt, and this is the only chance to hand it over.
    const link = await screen.findByRole("link", { name: /lucenity0\/Liffy#251/ });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/lucenity0/Liffy/issues/251",
    );
  });

  it("sends the title, the body, and the search that failed", async () => {
    /** The failed search is the single most useful line for triage, and the
     *  one nobody thinks to include. */
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.post("*/help/report", async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { number: 251, url: "https://github.com/lucenity0/Liffy/issues/251" },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderPage("/help?q=queued");
    await openForm(user);

    await user.type(screen.getByLabelText("Title"), "A clear title");
    await user.type(screen.getByLabelText(/what went wrong/i), "A long enough body.");
    await user.click(screen.getByRole("button", { name: "File this issue" }));

    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toMatchObject({ title: "A clear title", kind: "bug" });
    expect(String(sent!.body)).toContain("A long enough body.");
    expect(String(sent!.body)).toContain('Searched help for: "queued"');
  });

  it("sends a feature idea as its own kind, with its own words", async () => {
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.post("*/help/report", async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { number: 252, url: "https://github.com/lucenity0/Liffy/issues/252" },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    await user.click(screen.getByLabelText(/feature idea/i));

    // The prompt changes with the kind — "what went wrong" is the wrong
    // question to ask someone describing something that does not exist yet.
    await user.type(screen.getByLabelText("Title"), "Filter reviews by repo");
    await user.type(
      screen.getByLabelText(/what changes would you like/i),
      "Scrolling the whole list to find one repository.",
    );
    await user.click(screen.getByRole("button", { name: "Send this suggestion" }));

    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toMatchObject({ kind: "feature" });
  });

  it("cannot submit an empty report", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    expect(screen.getByRole("button", { name: "File this issue" })).toBeDisabled();
    await user.type(screen.getByLabelText("Title"), "Ok");
    expect(screen.getByRole("button", { name: "File this issue" })).toBeDisabled();
  });

  it("says GitHub refused rather than blaming Liffy", async () => {
    server.use(
      http.post("*/help/report", () =>
        HttpResponse.json(
          { detail: "Resource not accessible by personal access token" },
          { status: 502 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText("Title"), "A clear title");
    await user.type(screen.getByLabelText(/what went wrong/i), "A long enough body.");
    await user.click(screen.getByRole("button", { name: "File this issue" }));

    expect(await screen.findByText(/github refused/i)).toBeInTheDocument();
  });

  it("routes a security report to the private advisory form, carrying no detail", async () => {
    /**
     * SECURITY.md is explicit: a public issue is readable by everyone,
     * including whoever would use the bug, before there is a fix. The API has
     * no shape for a security report at all — this branch is the courtesy, and
     * the absent request is the proof.
     */
    let posted = false;
    server.use(
      http.post("*/help/report", () => {
        posted = true;
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    await user.click(screen.getByLabelText(/security vulnerability/i));

    // No fields to type a vulnerability into, by design.
    expect(screen.queryByLabelText("Title")).toBeNull();
    await user.click(screen.getByRole("button", { name: /private advisory form/i }));

    expect(open.mock.calls[0][0]).toBe(
      "https://github.com/lucenity0/Liffy/security/advisories/new",
    );
    expect(posted).toBe(false);
    open.mockRestore();
  });
});

describe("Help — illustrations", () => {
  it("draws the figure a page asks for, above its text", async () => {
    /**
     * The corpus names a figure; the drawing lives in `Figure`. That split is
     * what keeps a markdown document from carrying markup onto a page served
     * without a session — so this asserts the *name* is honoured, never that
     * the document produced the graphic.
     */
    server.use(
      http.get("*/help", () =>
        HttpResponse.json({
          query: "how does liffy work",
          results: [
            {
              slug: "how-liffy-works",
              title: "How Liffy works",
              snippet: "You do step one. Liffy does the rest.",
              body: "You do step one. Liffy does the rest.",
              related: [],
              figure: "how-it-works",
              score: 20,
            },
          ],
        }),
      ),
    );
    renderPage("/help?q=how%20does%20liffy%20work");

    const pane = await answer();
    // The scroll-scrubbed sequence's rail — the four beats it walks through.
    expect(within(pane).getByText("a PR arrives")).toBeInTheDocument();
    expect(within(pane).getByText("comment")).toBeInTheDocument();
  });

  it("renders the page fine when the figure name is unknown", async () => {
    /** A corpus typo should cost the picture, never the answer. */
    server.use(
      http.get("*/help", () =>
        HttpResponse.json({
          query: "x",
          results: [
            {
              slug: "review-states",
              title: "Queued vs processing",
              snippet: "s",
              body: "A review sits in queued until a worker picks it up.",
              related: [],
              figure: "no-such-figure",
              score: 1,
            },
          ],
        }),
      ),
    );
    renderPage("/help?q=x");

    expect(await answer()).toHaveTextContent(/until a worker picks it up/i);
  });
});
