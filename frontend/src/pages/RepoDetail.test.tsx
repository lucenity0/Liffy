import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import {
  fixtureRepoIndexed,
  fixtureRepoStatusIndexed,
  fixtureReviewListItems,
  reviewPage,
} from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import { RepoDetail } from "./RepoDetail";

function PathProbe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderDetail(repoId: string) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/repositories/:repoId" element={<RepoDetail />} />
      </Routes>
      <PathProbe />
    </>,
    { route: `/repositories/${repoId}` },
  );
}

describe("RepoDetail", () => {
  it("names the repo and shows its index status with the chunk count", async () => {
    renderDetail(fixtureRepoIndexed.id);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      fixtureRepoIndexed.full_name,
    );
    expect(await screen.findByText("Indexed")).toBeInTheDocument();
    expect(
      screen.getByText(String(fixtureRepoStatusIndexed.chunk_count)),
    ).toBeInTheDocument();
  });

  it("lists only this repo's reviews", async () => {
    renderDetail(fixtureRepoIndexed.id);

    const list = await screen.findByRole("list", {
      name: `Reviews for ${fixtureRepoIndexed.full_name}`,
    });
    const expected = fixtureReviewListItems.filter(
      (review) => review.repo_full_name === fixtureRepoIndexed.full_name,
    );

    expect(within(list).getAllByRole("listitem")).toHaveLength(expected.length);
    // The portfolio review is in the same fixture page and must not appear.
    expect(within(list).queryByText(/portfolio/)).toBeNull();
  });

  it("asks the API for this repo rather than filtering a shared page", async () => {
    let askedFor: string | null = null;
    server.use(
      http.get("*/reviews", ({ request }) => {
        askedFor = new URL(request.url).searchParams.get("repo_id");
        return HttpResponse.json(reviewPage([]));
      }),
    );

    renderDetail(fixtureRepoIndexed.id);
    await screen.findByRole("heading", { level: 1 });

    // The distinction that matters: filtering the global page client-side
    // showed nothing here once this repo's newest review fell off it, which
    // is a repo that looks unreviewed while its reviews sit in the database.
    await waitFor(() => expect(askedFor).toBe(fixtureRepoIndexed.id));
  });

  it("points at the full filtered list when it is showing a partial one", async () => {
    server.use(
      http.get("*/reviews", () =>
        // One row on the page, 30 in the repo.
        HttpResponse.json(reviewPage([fixtureReviewListItems[0]], 30)),
      ),
    );

    const user = userEvent.setup();
    renderDetail(fixtureRepoIndexed.id);

    // The pointer lives on the Reviews tab, not the Overview — Overview shows
    // a short recent list and sends you here rather than carrying two
    // different "see the rest" affordances.
    await user.click(await screen.findByRole("tab", { name: /^Reviews/ }));

    const link = await screen.findByRole("link", {
      name: /all reviews for this repository/i,
    });
    // Pre-filtered, so the link lands on this repo's reviews rather than
    // dropping the user into the unfiltered stream to find them again.
    expect(link).toHaveAttribute("href", `/reviews?repo=${fixtureRepoIndexed.id}`);
  });

  it("says the repo is not there rather than rendering an empty shell", async () => {
    renderDetail("00000000-0000-0000-0000-000000000000");

    expect(
      await screen.findByText(/no repository filed under that id/i),
    ).toBeInTheDocument();
  });

  it("queues a re-index and confirms it", async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.post("*/repos/:repoId/index", ({ params }) => {
        calls += 1;
        return HttpResponse.json(
          { repo_id: params.repoId, status: "queued" },
          { status: 202 },
        );
      }),
    );

    renderDetail(fixtureRepoIndexed.id);
    await screen.findByRole("heading", { level: 1 });

    await user.click(screen.getByRole("button", { name: "Re-index" }));

    expect(await screen.findByText(/re-index queued/i)).toBeInTheDocument();
    expect(calls).toBe(1);
  });

  it("leaves for the dashboard after disconnecting, since this page is about to be about nothing", async () => {
    const user = userEvent.setup();
    server.use(
      http.delete("*/repos/:repoId", () => new HttpResponse(null, { status: 204 })),
    );

    renderDetail(fixtureRepoIndexed.id);
    await screen.findByRole("heading", { level: 1 });

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent("/"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the repo readable when the reviews query fails", async () => {
    server.use(
      http.get("*/reviews", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    renderDetail(fixtureRepoIndexed.id);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      fixtureRepoIndexed.full_name,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
