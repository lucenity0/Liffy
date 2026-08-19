import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import { renderWithProviders } from "@/test/renderWithProviders";
import { CommitPicker } from "./CommitPicker";

const PR_ID = "cccccccc-0000-0000-0000-000000000001";

async function openPicker() {
  renderWithProviders(<CommitPicker prId={PR_ID} />);
  await userEvent.click(screen.getByRole("button", { name: "Fetch new commits" }));
  return screen.findByRole("list", { name: "Commits" });
}

describe("CommitPicker", () => {
  it("fetches nothing until asked", async () => {
    let called = false;
    server.use(
      http.get("*/prs/:prId/commits", () => {
        called = true;
        return HttpResponse.json([]);
      }),
    );

    renderWithProviders(<CommitPicker prId={PR_ID} />);

    // A GitHub call per review page opened, for a feature most visits do not
    // use — the button is the request.
    expect(called).toBe(false);
    expect(screen.getByRole("button", { name: "Fetch new commits" })).toBeInTheDocument();
  });

  it("keeps already-reviewed commits visible rather than hiding them", async () => {
    const list = await openPicker();

    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list).getAllByText("reviewed")).toHaveLength(2);
  });

  it("counts only the new commits in the header", async () => {
    await openPicker();
    const header = screen.getByText("Commits").closest("div")!;
    expect(within(header).getByText("2")).toBeInTheDocument();
  });

  it("cannot queue an empty selection", async () => {
    await openPicker();
    expect(screen.getByRole("button", { name: "Review selected" })).toBeDisabled();
  });

  it("sends exactly the ticked commits, skipping the ones left alone", async () => {
    let sent: string[] = [];
    server.use(
      http.post("*/prs/:prId/review-commits", async ({ request }) => {
        sent = ((await request.json()) as { shas: string[] }).shas;
        return HttpResponse.json({ status: "queued", pr_number: 42, commits: sent.length });
      }),
    );

    const list = await openPicker();
    // The README commit is deliberately skipped — the case this exists for.
    await userEvent.click(
      within(list).getByLabelText("fix: handle the null case"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Review 1 commit" }),
    );

    expect(sent).toEqual(["ddddddd4444444444444444444444444444444444"]);
  });

  it("pluralises the button by how many are ticked", async () => {
    const list = await openPicker();

    await userEvent.click(within(list).getByLabelText("fix: handle the null case"));
    expect(screen.getByRole("button", { name: "Review 1 commit" })).toBeEnabled();

    await userEvent.click(
      within(list).getByLabelText("docs: fix a typo in the README"),
    );
    expect(screen.getByRole("button", { name: "Review 2 commits" })).toBeEnabled();
  });

  it("surfaces a failed fetch with a retry rather than an empty list", async () => {
    server.use(
      http.get("*/prs/:prId/commits", () =>
        HttpResponse.json({ detail: "GitHub said no" }, { status: 502 }),
      ),
    );

    renderWithProviders(<CommitPicker prId={PR_ID} />);
    await userEvent.click(screen.getByRole("button", { name: "Fetch new commits" }));

    // Not the shared 502 copy, which says "couldn't find that repository" —
    // nonsense here, and it drops what the server actually said.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("GitHub would not list the commits.");
    expect(alert).toHaveTextContent("GitHub said no");
    expect(alert).not.toHaveTextContent("is it private");
  });
});
