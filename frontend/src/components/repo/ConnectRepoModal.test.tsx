import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server } from "@/mocks/server";
import { fixtureRepoIndexed } from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import { ConnectRepoModal } from "./ConnectRepoModal";

function open(knownRepoIds: string[] = []) {
  const onClose = vi.fn();
  renderWithProviders(
    <ConnectRepoModal onClose={onClose} knownRepoIds={new Set(knownRepoIds)} />,
  );
  return { onClose, user: userEvent.setup() };
}

const field = () => screen.getByRole("textbox", { name: /repository/i });
const submit = () => screen.getByRole("button", { name: "Connect" });

describe("ConnectRepoModal", () => {
  it("opens as a dialog with the input already focused", () => {
    open();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(field()).toHaveFocus();
  });

  it("rejects a malformed name without touching the network", async () => {
    const { user } = open();
    let posts = 0;
    server.use(
      http.post("*/repos", () => {
        posts += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await user.type(field(), "not-a-repo");
    await user.click(submit());

    expect(
      await screen.findByText(/doesn't look like owner\/name/i),
    ).toBeInTheDocument();
    // The whole point of validating here rather than reading the 422 back.
    expect(posts).toBe(0);
  });

  it("clears the validation error as soon as you start fixing it", async () => {
    const { user } = open();

    await user.type(field(), "nope");
    await user.click(submit());
    expect(
      await screen.findByText(/doesn't look like owner\/name/i),
    ).toBeInTheDocument();

    await user.type(field(), "/x");
    expect(screen.queryByText(/doesn't look like owner\/name/i)).toBeNull();
  });

  it("sends the normalized name and closes on a new repo", async () => {
    const { user, onClose } = open();
    let sent: string | undefined;
    server.use(
      http.post("*/repos", async ({ request }) => {
        sent = ((await request.json()) as { full_name: string }).full_name;
        return HttpResponse.json(
          {
            id: "99999999-9999-9999-9999-999999999999",
            full_name: sent,
            default_branch: "main",
            indexed_at: null,
            created_at: "2026-07-26T10:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

    await user.type(field(), "  lucenity0/portfolio  ");
    await user.click(submit());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent).toBe("lucenity0/portfolio");
  });

  it("says so rather than closing when the repo was already connected", async () => {
    const { user, onClose } = open([fixtureRepoIndexed.id]);
    server.use(
      http.post("*/repos", () =>
        // The backend answers 201 for a reconnect too, so the id is the only
        // thing that distinguishes this from a fresh connect.
        HttpResponse.json(fixtureRepoIndexed, { status: 201 }),
      ),
    );

    await user.type(field(), fixtureRepoIndexed.full_name);
    await user.click(submit());

    expect(await screen.findByText(/already connected/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // Closing on its own would look like nothing happened — no new card.
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("puts a 422 under the input, where the fix is", async () => {
    const { user } = open();
    server.use(
      http.post("*/repos", () =>
        HttpResponse.json(
          { detail: "full_name must look like 'owner/name'" },
          { status: 422 },
        ),
      ),
    );

    await user.type(field(), "a/b");
    await user.click(submit());

    expect(await screen.findByText(/must look like/i)).toBeInTheDocument();
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts a 502 under the input too — the name is what is wrong", async () => {
    const { user } = open();
    server.use(
      http.post("*/repos", () =>
        HttpResponse.json({ detail: "GitHub error" }, { status: 502 }),
      ),
    );

    await user.type(field(), "nonexistent/nope");
    await user.click(submit());

    expect(
      await screen.findByText(/couldn't find that repository/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts a 503 in a note instead — retyping the name will not help", async () => {
    const { user } = open();
    server.use(
      http.post("*/repos", () =>
        HttpResponse.json({ detail: "no token" }, { status: 503 }),
      ),
    );

    await user.type(field(), "a/b");
    await user.click(submit());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/no GitHub token configured/i);
    expect(field()).not.toHaveAttribute("aria-invalid");
  });

  it("puts an unreachable API in a note as well", async () => {
    const { user } = open();
    server.use(http.post("*/repos", () => HttpResponse.error()));

    await user.type(field(), "a/b");
    await user.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't reach the Liffy API/i,
    );
  });

  it("closes on Esc and on Cancel", async () => {
    const { user, onClose } = open();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("submits on Enter from the field, even though the button is in the footer", async () => {
    const { user, onClose } = open();
    server.use(
      http.post("*/repos", () =>
        HttpResponse.json(
          {
            id: "99999999-9999-9999-9999-999999999999",
            full_name: "a/b",
            default_branch: "main",
            indexed_at: null,
            created_at: "2026-07-26T10:00:00Z",
          },
          { status: 201 },
        ),
      ),
    );

    await user.type(field(), "a/b{Enter}");

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
