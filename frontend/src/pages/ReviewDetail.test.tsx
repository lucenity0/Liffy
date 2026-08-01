import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { server } from "@/mocks/server";
import {
  fixtureReviewApproved,
  fixtureReviewCompleted,
  fixtureReviewFailed,
  fixtureReviewPending,
  fixtureReviewProcessing,
} from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import { ReviewDetail } from "./ReviewDetail";

/** Mounted on the real path, so useParams sees a review id. */
function renderDetail(reviewId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/reviews/:reviewId" element={<ReviewDetail />} />
    </Routes>,
    { route: `/reviews/${reviewId}` },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ReviewDetail — completed", () => {
  it("names its pull request, which only the detail join can tell it", async () => {
    renderDetail(fixtureReviewCompleted.id);

    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(fixtureReviewCompleted.repo_full_name);
    expect(heading).toHaveTextContent(String(fixtureReviewCompleted.pr_number));
  });

  it("renders the summary and the run metadata", async () => {
    renderDetail(fixtureReviewCompleted.id);

    expect(
      await screen.findByText(fixtureReviewCompleted.summary!),
    ).toBeInTheDocument();
    expect(screen.getByText(/gpt-4o · 4,213 tokens · 2m 15s/)).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Request changes")).toBeInTheDocument();
  });

  it("groups comments by file, alphabetically, with the file's worst severity on the header", async () => {
    renderDetail(fixtureReviewCompleted.id);

    await screen.findByText(fixtureReviewCompleted.summary!);
    // Scoped: the diff viewer renders <details> per file too, and both stacks
    // expose the group role.
    const comments = screen.getByRole("region", { name: "Comments" });
    const groups = within(comments).getAllByRole("group");

    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getByText("setup-mac.sh")).toBeInTheDocument();
    expect(within(groups[1]).getByText("src/lib/diff.ts")).toBeInTheDocument();
    // The critical one is in diff.ts, and its group header says so.
    expect(
      within(groups[1]).getAllByText("Critical").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("shows a suggestion block only for the comments that have one", async () => {
    renderDetail(fixtureReviewCompleted.id);

    await screen.findByText(fixtureReviewCompleted.summary!);

    const withSuggestion = fixtureReviewCompleted.comments.find(
      (c) => c.suggestion,
    )!;
    expect(screen.getByText(withSuggestion.suggestion!)).toBeInTheDocument();

    // Both fixture comments carry one, so assert the count matches rather
    // than asserting an absence that could pass for the wrong reason.
    expect(screen.getAllByText("Suggestion")).toHaveLength(
      fixtureReviewCompleted.comments.filter((c) => c.suggestion).length,
    );
  });

  it("says so plainly when Liffy had nothing to flag", async () => {
    renderDetail(fixtureReviewApproved.id);

    expect(await screen.findByText(/nothing to flag/i)).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Comments" })).queryByRole("group"),
    ).toBeNull();
  });
});

describe("ReviewDetail — in flight", () => {
  it("shows the reading panel for a processing review", async () => {
    renderDetail(fixtureReviewProcessing.id);

    expect(await screen.findByText(/liffy is reading the diff/i)).toBeInTheDocument();
    // Nothing to summarize yet.
    expect(screen.queryByText("Summary")).toBeNull();
  });

  it("distinguishes queued from reading", async () => {
    renderDetail(fixtureReviewPending.id);

    expect(await screen.findByText(/waiting for a worker/i)).toBeInTheDocument();
  });

  it("flips to the finished review on its own when the poll comes back completed", async () => {
    vi.useFakeTimers();
    let calls = 0;
    server.use(
      http.get("*/reviews/:reviewId", () => {
        calls += 1;
        return HttpResponse.json(
          calls < 2 ? fixtureReviewProcessing : fixtureReviewCompleted,
        );
      }),
    );

    renderDetail(fixtureReviewProcessing.id);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/liffy is reading the diff/i)).toBeInTheDocument();

    // One poll interval later the worker has finished — no refresh, no click.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // A second flush: the interval fires the request, and the response lands
    // a microtask later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(calls).toBe(2);
    expect(screen.getByText(fixtureReviewCompleted.summary!)).toBeInTheDocument();
    expect(screen.queryByText(/liffy is reading the diff/i)).toBeNull();
  });

  it("disables Re-review while the worker still has it", async () => {
    renderDetail(fixtureReviewProcessing.id);

    expect(
      await screen.findByRole("button", { name: "Re-review" }),
    ).toBeDisabled();
  });
});

describe("ReviewDetail — failed", () => {
  it("explains the failure and leaves Re-review available", async () => {
    renderDetail(fixtureReviewFailed.id);

    expect(await screen.findByText(/did not finish/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-review" })).toBeEnabled();
    expect(screen.queryByText("Summary")).toBeNull();
  });
});

describe("ReviewDetail — re-review", () => {
  it("queues a new review and says where it will appear, rather than pretending this one restarted", async () => {
    const user = userEvent.setup();
    let posted: string | null = null;
    server.use(
      http.post("*/reviews/:reviewId/trigger", ({ params }) => {
        posted = params.reviewId as string;
        return HttpResponse.json(
          { status: "queued", repo: "lucenity0/Liffy", pr_number: 58 },
          { status: 202 },
        );
      }),
    );

    renderDetail(fixtureReviewCompleted.id);
    await screen.findByText(fixtureReviewCompleted.summary!);

    await user.click(screen.getByRole("button", { name: "Re-review" }));

    expect(await screen.findByText(/re-review queued/i)).toBeInTheDocument();
    expect(posted).toBe(fixtureReviewCompleted.id);
    // The current review is untouched — POST /reviews/{id}/trigger makes a new
    // row — so the page must not claim to be processing.
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /see all reviews/i })).toHaveAttribute(
      "href",
      "/reviews",
    );
  });

  it("reports a failed re-review on the page", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/reviews/:reviewId/trigger", () =>
        HttpResponse.json({ detail: "nope" }, { status: 404 }),
      ),
    );

    renderDetail(fixtureReviewCompleted.id);
    await screen.findByText(fixtureReviewCompleted.summary!);

    await user.click(screen.getByRole("button", { name: "Re-review" }));

    expect(await screen.findByText("nope")).toBeInTheDocument();
  });
});

describe("ReviewDetail — rating comments", () => {
  /**
   * Groups sort by file path, so `setup-mac.sh` comes before
   * `src/lib/diff.ts` — card 0 is the unrated comment, card 1 the one the
   * fixture already rated 1. Both initial states are asserted below rather
   * than assumed, so a fixture change fails here instead of silently
   * inverting what the test means.
   */
  async function cards() {
    await screen.findByText(fixtureReviewCompleted.summary!);
    // Scoped: the diff viewer renders its own stack of the same comments.
    const comments = screen.getByRole("region", { name: "Comments" });
    return within(comments).getAllByRole("article");
  }

  it("rates a comment in place, and the rating survives the refetch", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderDetail(fixtureReviewCompleted.id);

    const [unrated, alreadyRated] = await cards();
    const helpful = within(unrated).getByRole("button", { name: "Helpful" });
    expect(helpful).toHaveAttribute("aria-pressed", "false");
    expect(
      within(alreadyRated).getByRole("button", { name: "Helpful" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(helpful);

    await waitFor(() => expect(helpful).toHaveAttribute("aria-pressed", "true"));
    // The page never went back to a skeleton — the same review is still
    // mounted around the button that was clicked.
    expect(screen.getByText(fixtureReviewCompleted.summary!)).toBeInTheDocument();

    // And it is still pressed once `onSettled`'s invalidation has refetched,
    // which is the difference between an optimistic write and a real one.
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(helpful).toHaveAttribute("aria-pressed", "true");
  });

  it("switches sides without leaving both thumbs pressed", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderDetail(fixtureReviewCompleted.id);

    const [, alreadyRated] = await cards();
    await user.click(
      within(alreadyRated).getByRole("button", { name: "Not helpful" }),
    );

    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(
      within(alreadyRated).getByRole("button", { name: "Helpful" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(alreadyRated).getByRole("button", { name: "Not helpful" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * The settle refetch is held open on purpose.
   *
   * Written the obvious way — click, fail, assert unpressed — this test passes
   * with `onError` deleted entirely, because `onSettled` invalidates and the
   * server's answer puts the thumb back on its own. Blocking that answer
   * leaves the rollback as the only thing that can restore the control, which
   * is the behaviour the test is named after.
   */
  it("puts the thumb back on failure, before the server gets a chance to", async () => {
    server.use(
      http.post("*/comments/:commentId/feedback", () =>
        HttpResponse.json(
          {
            detail: [
              { type: "literal_error", loc: ["body", "rating"], msg: "bad" },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    let release!: () => void;
    const refetched = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detailCalls = 0;
    server.use(
      http.get("*/reviews/:reviewId", async () => {
        detailCalls += 1;
        if (detailCalls > 1) await refetched;
        return HttpResponse.json(fixtureReviewCompleted);
      }),
    );

    const user = userEvent.setup();
    const { queryClient } = renderDetail(fixtureReviewCompleted.id);

    const [unrated] = await cards();
    const helpful = within(unrated).getByRole("button", { name: "Helpful" });

    await user.click(helpful);

    const alert = await within(unrated).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save that rating.");
    expect(alert).not.toHaveTextContent(/owner\/name/);

    // Still in flight, so nothing but the rollback has touched the cache.
    expect(queryClient.isFetching()).toBeGreaterThan(0);
    expect(helpful).toHaveAttribute("aria-pressed", "false");

    release();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  });
});

describe("ReviewDetail — missing", () => {
  it("says the review is not there instead of showing a raw 404", async () => {
    renderDetail("00000000-0000-0000-0000-000000000000");

    expect(
      await screen.findByText(/no review filed under that id/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /all reviews/i })).toBeInTheDocument();
  });

  it("shows a retryable error for anything else", async () => {
    server.use(
      http.get("*/reviews/:reviewId", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    renderDetail(fixtureReviewCompleted.id);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("boom");
    await waitFor(() =>
      expect(within(alert).getByRole("button", { name: /try again/i })).toBeInTheDocument(),
    );
  });
});
