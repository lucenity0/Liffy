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
/**
 * The pull request is a live list when the repository is one Liffy knows, and
 * a number box otherwise — plus a way back to the box for anything the list
 * cannot express, which is what the invalid-number cases need.
 */
async function choosePr(
  user: ReturnType<typeof userEvent.setup>,
  value: string,
) {
  const box = screen.queryByRole("textbox", { name: /pull request/i });
  if (box) {
    await user.type(box, value);
    return;
  }
  const listed = screen.queryByRole("button", { name: new RegExp(`#${value}\\b`) });
  if (listed) {
    await user.click(listed);
    return;
  }
  await user.click(
    screen.getAllByRole("button", { name: /enter a number instead/i })[0],
  );
  await user.type(screen.getByRole("textbox", { name: /pull request/i }), value);
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
    await choosePr(user, "58");
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
    await choosePr(user, "58");
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
      // None of these can be expressed in the list, so every case here goes
      // through the escape hatch — which is the point: the box still has to
      // reject them, and the picker must not have removed that guard.
      await user.click(
        screen.getAllByRole("button", { name: /enter a number instead/i })[0],
      );
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
    await choosePr(user, "58");
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
    await choosePr(user, "58");
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

// ── The pull request picker ──────────────────────────────────────────────────
//
// Starting a review used to begin with reading a number off a GitHub URL.
// GET /repos/{id}/pulls exists so this step can be a list instead.

describe("choosing a pull request from the list", () => {
  it("lists the repository's open pull requests and submits the one picked", async () => {
    const { user } = open();
    let sent: { owner: string; repo: string; pr_number: number } | null = null;
    server.use(
      http.post("*/reviews/trigger", async ({ request }) => {
        sent = (await request.json()) as typeof sent;
        return HttpResponse.json(
          { status: "queued", repo: "lucenity0/Liffy", pr_number: 253 },
          { status: 202 },
        );
      }),
    );

    await chooseRepo(user, "lucenity0/Liffy");
    await user.click(await screen.findByRole("button", { name: /#253/ }));
    await user.click(submit());

    // Still the same three fields on the wire — the picker changed how the
    // number is chosen, not what gets posted.
    await waitFor(() =>
      expect(sent).toEqual({
        owner: "lucenity0",
        repo: "Liffy",
        pr_number: 253,
      }),
    );
  });

  it("filters the list by state, and by what you type", async () => {
    const { user } = open();
    await chooseRepo(user, "lucenity0/Liffy");

    // Open by default; the closed one is not in it.
    expect(await screen.findByRole("button", { name: /#253/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /#246/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /^closed/i }));
    expect(await screen.findByRole("button", { name: /#246/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /#253/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /^open/i }));
    await user.type(
      await screen.findByRole("searchbox", { name: /search pull requests/i }),
      "management",
    );
    expect(screen.getByRole("button", { name: /#251/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /#253/ })).toBeNull();
  });

  /**
   * The list is a live GitHub proxy, so it can rate-limit or fail on a
   * repository the caller's token cannot enumerate. "The picker is broken so
   * you cannot start a review" would be worse than the typing it replaced.
   */
  it("offers the number box when the list cannot be loaded", async () => {
    server.use(
      http.get("*/repos/:repoId/pulls", () =>
        HttpResponse.json({ detail: "rate limited" }, { status: 429 }),
      ),
    );
    const { user } = open();

    await chooseRepo(user, "lucenity0/Liffy");
    await user.click(
      await screen.findByRole("button", { name: /enter a number instead/i }),
    );

    expect(prField()).toBeInTheDocument();
  });
});

// ── What the mockup in review_ui.md asks the pocket to show ──────────────────

describe("the pull request pocket", () => {
  it("says how recently each pull request moved", async () => {
    const { user } = open();
    await chooseRepo(user, "lucenity0/Liffy");

    const row = await screen.findByRole("button", { name: /#253/ });

    // The list is sorted by activity; without this on the row it shows an
    // order it cannot explain.
    const when = within(row).getByRole("time");
    expect(when).toHaveAttribute("datetime", "2026-07-26T13:44:00Z");
  });

  it("drops the timestamp rather than rendering a broken date", async () => {
    const { user } = open();
    await chooseRepo(user, "lucenity0/Liffy");
    await user.click(await screen.findByRole("button", { name: /^closed/i }));

    // #246's updated_at is null — GitHub can omit it, and "Invalid Date" in a
    // picker is worse than no timestamp.
    const row = await screen.findByRole("button", { name: /#246/ });
    expect(within(row).queryByRole("time")).toBeNull();
  });

  it("counts both tabs, not only the one you are on", async () => {
    const { user } = open();
    await chooseRepo(user, "lucenity0/Liffy");

    // A tab whose number appears only after you press it cannot tell you
    // whether pressing it is worth it.
    const closed = await screen.findByRole("button", { name: /^closed/i });
    await waitFor(() => expect(closed).toHaveTextContent("1"));
    expect(
      await screen.findByRole("button", { name: /^open/i }),
    ).toHaveTextContent("2");
  });

  it("shows what you are looking at out of what there is", async () => {
    const { user } = open();
    await chooseRepo(user, "lucenity0/Liffy");

    await screen.findByRole("button", { name: /#253/ });
    expect(screen.getByText("1–2 of 2")).toBeInTheDocument();
  });

  it("does not claim a total when the page came back full", async () => {
    server.use(
      http.get("*/repos/:repoId/pulls", () =>
        HttpResponse.json({
          items: Array.from({ length: 50 }, (_, i) => ({
            number: 900 - i,
            title: `PR ${900 - i}`,
            author: "lucenity0",
            head_branch: "f",
            base_branch: "main",
            state: "open",
            updated_at: "2026-07-26T10:00:00Z",
          })),
          state: "open",
          // Null: a full page means "at least 50", which is not a total.
          total: null,
        }),
      ),
    );
    const { user } = open();
    await chooseRepo(user, "lucenity0/Liffy");

    await screen.findByRole("button", { name: /#900/ });
    expect(screen.getByText("1–50")).toBeInTheDocument();
    expect(screen.queryByText(/of 50/)).toBeNull();
  });
});
