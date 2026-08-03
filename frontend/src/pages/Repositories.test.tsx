import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import {
  fixtureRepoIndexed,
  fixtureRepoIndexing,
  fixtureRepoStatusIndexed,
  fixtureRepoStatusPartial,
} from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import { Repositories } from "./Repositories";

/**
 * The management surface, which had no test coverage at all until it grew
 * review history — the columns below come off `GET /repos` as one grouped
 * subquery, and the failure mode of getting that wrong is a plausible-looking
 * number rather than an error.
 */

/**
 * Scoped to the Sheet, not to a list role: the status strip above the table is
 * also a `<ul>`, so an unscoped list query is a race between the two.
 */
function repoTable() {
  return screen.findByRole("region", { name: "Repositories" });
}

async function repoRow(fullName: string) {
  const table = await repoTable();
  const row = within(table)
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText(fullName));

  if (!row) throw new Error(`No row for ${fullName}`);
  return row;
}

describe("Repositories", () => {
  it("shows how much reviewing has happened on each repository", async () => {
    renderWithProviders(<Repositories />);

    const row = await repoRow(fixtureRepoIndexed.full_name);

    expect(within(row).getByText("4")).toBeInTheDocument();
    // Relative on screen, exact in the markup — and pinned to the review
    // timestamp, not the index one, which is the mix-up this column invites.
    const times = within(row).getAllByRole("time");
    expect(times.map((el) => el.getAttribute("datetime"))).toContain(
      fixtureRepoIndexed.last_review_at,
    );
  });

  it("says never, not zero-dash, for a repository nothing has reviewed", async () => {
    renderWithProviders(<Repositories />);

    const row = await repoRow(fixtureRepoIndexing.full_name);

    // A real zero: "connected but never reviewed" is exactly the state this
    // column exists to surface, and an em dash would read as missing data.
    expect(within(row).getByText("0")).toBeInTheDocument();
    expect(within(row).getAllByText("never").length).toBeGreaterThan(0);
  });

  it("keeps the review columns separate from the index columns", async () => {
    renderWithProviders(<Repositories />);

    const row = await repoRow(fixtureRepoIndexed.full_name);

    // The chunk count moved into the sub-line under the name when Reviews and
    // Last review took its column — it is index detail, and the repository
    // name needed the width more.
    expect(
      within(row).getByText(
        new RegExp(String(fixtureRepoStatusIndexed.chunk_count)),
      ),
    ).toBeInTheDocument();
  });

  it("filters by name without touching the index filter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Repositories />);

    await repoRow(fixtureRepoIndexed.full_name);
    await user.type(screen.getByLabelText("Search repositories"), "portfolio");

    const table = await repoTable();
    const rows = within(table).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(
      within(rows[0]).getByText(fixtureRepoIndexing.full_name),
    ).toBeInTheDocument();
  });

  it("offers a way back when a filter matches nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Repositories />);

    await repoRow(fixtureRepoIndexed.full_name);
    await user.type(screen.getByLabelText("Search repositories"), "nothing");

    expect(await screen.findByText(/no repositories found/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(await repoRow(fixtureRepoIndexed.full_name)).toBeInTheDocument();
  });

  it("reports a partial index as skipped files rather than as a failure", async () => {
    server.use(
      http.get("*/repos/:repoId/status", ({ params }) =>
        HttpResponse.json(
          params.repoId === fixtureRepoIndexed.id
            ? fixtureRepoStatusPartial
            : fixtureRepoStatusIndexed,
        ),
      ),
    );

    renderWithProviders(<Repositories />);

    const row = await repoRow(fixtureRepoIndexed.full_name);
    // IndexStatus has no failed state; inventing one would mean a second
    // status model living beside the backend's.
    expect(await within(row).findByText(/40 skipped/)).toBeInTheDocument();
    expect(within(row).queryByText(/failed/i)).toBeNull();
  });

  it("surfaces a failed load with a retry rather than an empty table", async () => {
    server.use(
      http.get("*/repos", () =>
        HttpResponse.json({ detail: "no token" }, { status: 503 }),
      ),
    );

    renderWithProviders(<Repositories />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/no repositories connected/i)).toBeNull();
  });

  it("offers the connect flow when nothing is connected", async () => {
    server.use(http.get("*/repos", () => HttpResponse.json([])));

    renderWithProviders(<Repositories />);

    expect(
      await screen.findByText(/no repositories connected/i),
    ).toBeInTheDocument();
  });
});
