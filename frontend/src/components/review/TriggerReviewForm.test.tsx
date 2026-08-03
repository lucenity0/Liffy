import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server } from "@/mocks/server";
import { renderWithProviders } from "@/test/renderWithProviders";
import { TriggerReviewForm } from "./TriggerReviewForm";

function open() {
  const onClose = vi.fn();
  const onQueued = vi.fn();
  renderWithProviders(
    <TriggerReviewForm onClose={onClose} onQueued={onQueued} />,
  );
  return { onClose, onQueued, user: userEvent.setup() };
}

/**
 * The repository control is a picker once repositories are connected, and the
 * free-text box before that — so a test says which repository it wants and
 * lets this find the right way to say it.
 */
async function chooseRepo(
  user: ReturnType<typeof userEvent.setup>,
  value: string,
) {
  // Waits for /repos to settle: the field is a disabled placeholder until
  // then, precisely so it cannot swap under someone mid-keystroke.
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: /repository/i }),
    ).not.toBeDisabled(),
  ).catch(() => {});

  const select = screen.queryByRole("combobox", { name: /repository/i });
  if (!select) {
    await user.type(screen.getByRole("textbox", { name: /repository/i }), value);
    return;
  }
  const known = within(select)
    .queryAllByRole("option")
    .some((option) => option.textContent === value);
  if (known) {
    await user.selectOptions(select, value);
    return;
  }
  // Not one Liffy has indexed — the endpoint still accepts it, via the
  // escape hatch the picker keeps for exactly this.
  await user.selectOptions(select, "__custom__");
  await user.type(screen.getByRole("textbox", { name: /repository/i }), value);
}
const prField = () => screen.getByRole("textbox", { name: /pull request/i });
const submit = () => screen.getByRole("button", { name: "Start review" });

describe("TriggerReviewForm", () => {
  it("posts owner, repo and pr_number as three separate fields", async () => {
    const { user, onQueued } = open();
    let body: unknown;
    server.use(
      http.post("*/reviews/trigger", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { status: "queued", repo: "lucenity0/Liffy", pr_number: 58 },
          { status: 202 },
        );
      }),
    );

    await chooseRepo(user, "lucenity0/Liffy");
    await user.type(prField(), "58");
    await user.click(submit());

    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    // One field on screen, the API's three in the body.
    expect(body).toEqual({ owner: "lucenity0", repo: "Liffy", pr_number: 58 });
    expect(onQueued).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "lucenity0/Liffy", pr_number: 58 }),
    );
  });

  it("blocks a malformed repository without touching the network", async () => {
    const { user } = open();
    let posts = 0;
    server.use(
      http.post("*/reviews/trigger", () => {
        posts += 1;
        return HttpResponse.json({}, { status: 202 });
      }),
    );

    await chooseRepo(user, "not-a-repo");
    await user.type(prField(), "58");
    await user.click(submit());

    expect(
      await screen.findByText(/doesn't look like owner\/name/i),
    ).toBeInTheDocument();
    expect(posts).toBe(0);
  });

  it.each(["0", "-1", "1.5", "abc", ""])(
    "blocks pr number %j without touching the network",
    async (value) => {
      const { user } = open();
      let posts = 0;
      server.use(
        http.post("*/reviews/trigger", () => {
          posts += 1;
          return HttpResponse.json({}, { status: 202 });
        }),
      );

      await chooseRepo(user, "lucenity0/Liffy");
      if (value) await user.type(prField(), value);
      await user.click(submit());

      expect(
        await screen.findByText(/whole number above zero/i),
      ).toBeInTheDocument();
      expect(posts).toBe(0);
    },
  );

  it("shows both messages at once when both fields are wrong", async () => {
    const { user } = open();

    await user.click(submit());

    expect(
      await screen.findByText(/doesn't look like owner\/name/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/whole number above zero/i)).toBeInTheDocument();
  });

  it("renders a server 422 under the repository field", async () => {
    const { user } = open();
    server.use(
      http.post("*/reviews/trigger", () =>
        HttpResponse.json({ detail: "repo not connected" }, { status: 422 }),
      ),
    );

    await chooseRepo(user, "lucenity0/Liffy");
    await user.type(prField(), "58");
    await user.click(submit());

    expect(await screen.findByText("repo not connected")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts a 503 in a note instead — the fields are not the problem", async () => {
    const { user } = open();
    server.use(
      http.post("*/reviews/trigger", () =>
        HttpResponse.json({ detail: "no token" }, { status: 503 }),
      ),
    );

    await chooseRepo(user, "lucenity0/Liffy");
    await user.type(prField(), "58");
    await user.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no GitHub token configured/i,
    );
  });

  it("closes on Cancel", async () => {
    const { user, onClose } = open();

    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
