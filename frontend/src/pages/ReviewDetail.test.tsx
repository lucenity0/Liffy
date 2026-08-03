import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { server } from "@/mocks/server";
import {
  fixtureEvalBelowTarget,
  fixtureEvalNoComments,
  fixtureEvalRated,
  fixtureEvalUnrated,
  fixtureReviewApproved,
  fixtureReviewCompleted,
  fixtureReviewFailed,
  fixtureReviewPending,
  fixtureReviewProcessing,
} from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import type { EvalScoresOut } from "@/types/api";
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

/**
 * The page is a tabbed workspace now, so most assertions live behind one.
 *
 * Waits for the strip before clicking: the tabs only mount once the review
 * has loaded and its status is `completed`, so a click fired against the
 * skeleton would race.
 */
async function goToTab(
  name: "Summary" | "Files" | "Comments" | "Changes",
  user = userEvent.setup(),
) {
  await user.click(
    await screen.findByRole("tab", { name: new RegExp(`^${name}`) }),
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

  /**
   * Findings are listed worst-first across the whole review rather than
   * grouped by file. The Comments tab answers "what did it find"; the Files
   * tab is where the same findings sit next to their code, so grouping them
   * by file in both places was the same answer twice.
   */
  it("lists every finding worst-first, with a filter per severity present", async () => {
    renderDetail(fixtureReviewCompleted.id);
    await goToTab("Comments");

    const comments = screen.getByRole("region", { name: "Comments" });
    const cards = within(comments).getAllByRole("article");
    expect(cards).toHaveLength(fixtureReviewCompleted.comments.length);

    // Critical sorts first regardless of which file it is in — the fixture's
    // critical lives in src/lib/diff.ts, which sorts *after* setup-mac.sh.
    expect(within(cards[0]).getByText("Critical")).toBeInTheDocument();
    expect(within(cards[0]).getByText(/src\/lib\/diff\.ts/)).toBeInTheDocument();

    // "All", plus only the severities this review actually contains — a
    // "Critical 0" button leading to an empty list is a dead control.
    expect(screen.getByRole("button", { name: /^All/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^critical/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^warning/i })).toBeNull();
  });

  it("narrows to one severity when its filter is pressed", async () => {
    const user = userEvent.setup();
    renderDetail(fixtureReviewCompleted.id);
    await goToTab("Comments", user);

    await user.click(screen.getByRole("button", { name: /^critical/i }));

    const comments = screen.getByRole("region", { name: "Comments" });
    const cards = within(comments).getAllByRole("article");
    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByText("Critical")).toBeInTheDocument();
  });

  it("shows a suggestion block only for the comments that have one", async () => {
    renderDetail(fixtureReviewCompleted.id);
    await goToTab("Comments");

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
    await goToTab("Comments");

    expect(await screen.findByText(/nothing flagged/i)).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Comments" })).queryByRole("article"),
    ).toBeNull();
  });
});

describe("ReviewDetail — in flight", () => {
  /**
   * The panel says what the worker is doing, and every state in it is derived
   * from something the API proves. The pipeline fetches the diff *before* it
   * inserts the row, so anything in `processing` has provably finished
   * fetching — that is the one step allowed to read "complete".
   */
  it("shows the pipeline for a processing review", async () => {
    renderDetail(fixtureReviewProcessing.id);

    const panel = await screen.findByRole("region", { name: "Review progress" });
    expect(within(panel).getByText("Fetch")).toBeInTheDocument();
    expect(within(panel).getByText("complete")).toBeInTheDocument();
    // Retrieval and review are reported together — the worker records one
    // status for both, so neither is claimed to be further along.
    expect(within(panel).getAllByText("running")).toHaveLength(2);
    // Nothing to summarize yet.
    expect(screen.queryByRole("tab", { name: /^Summary/ })).toBeNull();
  });

  it("claims nothing has started while the review is still queued", async () => {
    renderDetail(fixtureReviewPending.id);

    const panel = await screen.findByRole("region", { name: "Review progress" });
    // No worker has touched it, so not even Fetch may read complete.
    expect(within(panel).queryByText("complete")).toBeNull();
    expect(within(panel).getAllByText("waiting").length).toBeGreaterThan(0);
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
    expect(screen.getByRole("region", { name: "Review progress" })).toBeInTheDocument();

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
    expect(screen.queryByRole("region", { name: "Review progress" })).toBeNull();
  });

  it("disables Re-review while the worker still has it", async () => {
    renderDetail(fixtureReviewProcessing.id);

    expect(
      await screen.findByRole("button", { name: "Re-review" }),
    ).toBeDisabled();
  });
});

describe("ReviewDetail — the overview", () => {
  it("shows what the PR does on the summary, and what changed where on its own tab", async () => {
    /**
     * A paragraph gets skimmed. A short list of what the change *does* and a
     * table of what changed where gets read — and it carries the review even
     * when it found nothing worth commenting on, which is a common and correct
     * outcome that used to leave this panel looking empty.
     *
     * The two now live apart: the short list stays on Summary, the file table
     * moved to Changes so it no longer sits between the reader and the code.
     */
    const user = userEvent.setup();
    renderDetail(fixtureReviewCompleted.id);

    expect(await screen.findByText("What changed")).toBeInTheDocument();
    expect(
      screen.getByText(/adds a token bucket in front of the review trigger/i),
    ).toBeInTheDocument();

    await goToTab("Changes", user);
    expect(screen.getByText("backend/app/api/reviews.py")).toBeInTheDocument();
    expect(
      screen.getByText(/applies the new limiter to the trigger route/i),
    ).toBeInTheDocument();
  });

  it("renders a prose-only review without a page of empty headings", async () => {
    /**
     * Null means the model was never asked or answered only prose — every
     * review written before this landed. It must not render as a page of
     * empty headings.
     */
    server.use(
      http.get("*/reviews/:reviewId", () =>
        HttpResponse.json({
          ...fixtureReviewCompleted,
          summary_detail: null,
          comments: [],
        }),
      ),
    );
    renderDetail(fixtureReviewCompleted.id);

    await screen.findByText(/diff-hunk parser/i);
    expect(screen.queryByText("What changed")).toBeNull();
    // "Review focus" only earns its space when there is something to plot.
    expect(screen.queryByText("Review focus")).toBeNull();
  });
});

describe("ReviewDetail — failed", () => {
  it("explains the failure and leaves Re-review available", async () => {
    renderDetail(fixtureReviewFailed.id);

    expect(await screen.findByText(/did not finish/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-review" })).toBeEnabled();
    expect(screen.queryByText("Summary")).toBeNull();
    // Nothing stored: the older row shape, where pointing at the log is the
    // best available answer.
    expect(screen.getByText(/worker log has the reason/i)).toBeInTheDocument();
  });

  it("shows the reason the worker stored instead of guessing at causes", async () => {
    /**
     * The page used to print a list of plausible causes — "a missing or
     * rate-limited LLM key, or a diff too large for the model's context" —
     * because the row genuinely carried nothing. Once the worker started
     * writing the reason down, the guesses stayed and hid it. The real failure
     * was `'claude' is not on PATH`: not on that list, fixed in one step, and
     * reachable only by reading container logs.
     */
    server.use(
      http.get("*/reviews/:reviewId", () =>
        HttpResponse.json({
          ...fixtureReviewFailed,
          summary:
            "Review failed: 'claude' is not on PATH. Install Claude Code and sign in, or set LLM_PROVIDER to a different provider.",
          comments: [],
          raw_diff: null,
        }),
      ),
    );
    renderDetail(fixtureReviewFailed.id);

    expect(
      await screen.findByText(/'claude' is not on PATH/i),
    ).toBeInTheDocument();
    // The prefix belongs to the list's one-liner, not to this panel.
    expect(screen.queryByText(/^Review failed:/)).toBeNull();
    // And the guesses do not come back alongside it.
    expect(screen.queryByText(/diff too large/i)).toBeNull();
    expect(screen.queryByText(/worker log has the reason/i)).toBeNull();
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
   * Findings sort worst-first, so the critical one in `src/lib/diff.ts` is
   * card 0 and the info in `setup-mac.sh` is card 1. The fixture rates the
   * diff.ts comment 1 and leaves the other unrated, so this returns
   * [alreadyRated, unrated] — the reverse of the old file-sorted order.
   * Both initial states are asserted at the call sites rather than assumed,
   * so a fixture change fails there instead of silently inverting the test.
   */
  async function cards(user?: ReturnType<typeof userEvent.setup>) {
    await goToTab("Comments", user);
    const comments = screen.getByRole("region", { name: "Comments" });
    return within(comments).getAllByRole("article");
  }

  it("rates a comment in place, and the rating survives the refetch", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderDetail(fixtureReviewCompleted.id);

    const [alreadyRated, unrated] = await cards(user);
    const helpful = within(unrated).getByRole("button", { name: "Helpful" });
    expect(helpful).toHaveAttribute("aria-pressed", "false");
    expect(
      within(alreadyRated).getByRole("button", { name: "Helpful" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(helpful);

    await waitFor(() => expect(helpful).toHaveAttribute("aria-pressed", "true"));
    // The page never went back to a skeleton — the same tab is still mounted
    // around the button that was clicked, with the other card still beside it.
    expect(within(alreadyRated).getByRole("button", { name: "Helpful" })).toBeInTheDocument();

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

    const [, unrated] = await cards(user);
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

describe("ReviewDetail — approval score", () => {
  /** Pins one of the eval states, since the default handler derives it. */
  function withScores(scores: EvalScoresOut) {
    server.use(
      http.get("*/reviews/:reviewId/eval", () => HttpResponse.json(scores)),
    );
  }

  /**
   * The Rating block. Awaited, not queried synchronously: ReviewDetail shows
   * a skeleton first, and the Sheet itself mounts before its query resolves —
   * so every assertion inside it has to be a `find`, not a `get`.
   */
  /**
   * The score moved onto the Comments tab, next to the ratings that feed it —
   * rating a comment and watching the rate move were otherwise on opposite
   * ends of the page, and would now be on different tabs entirely.
   */
  const rating = async () => {
    await goToTab("Comments");
    return screen.findByRole("region", { name: "Rating" });
  };

  it("shows the approval rate for a rated review", async () => {
    withScores(fixtureEvalRated);
    renderDetail(fixtureReviewCompleted.id);

    // 0.8333… rounded once, at render.
    expect(await within(await rating()).findByText("83%")).toBeInTheDocument();
  });

  /**
   * The headline test. `approval_rate ?? 0` renders "0%" and would pass every
   * other assertion in this block, so the absence of that string is the thing
   * being checked — a review nobody has rated has not been rejected.
   */
  it("shows an empty state when the rate is null, and never 0%", async () => {
    withScores(fixtureEvalUnrated);
    renderDetail(fixtureReviewCompleted.id);

    const region = await rating();
    expect(await within(region).findByText("No ratings yet.")).toBeInTheDocument();
    expect(within(region).queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  /**
   * `0` is a real value meaning every rating was negative, and it has to
   * render as a number rather than collapsing into the empty state — the
   * mirror of the test above, and the reason neither may be a falsy check.
   */
  it("renders a genuine 0% as a score, not as 'no ratings'", async () => {
    withScores({
      ...fixtureEvalRated,
      approval_rate: 0,
      false_positive_rate: 1,
      rated_comments: 3,
    });
    renderDetail(fixtureReviewCompleted.id);

    const region = await rating();
    expect(await within(region).findByText("0%")).toBeInTheDocument();
    expect(within(region).queryByText("No ratings yet.")).not.toBeInTheDocument();
  });

  it("shows the rated-of-total denominator next to the rate", async () => {
    withScores(fixtureEvalRated);
    renderDetail(fixtureReviewCompleted.id);

    expect(
      await within(await rating()).findByText("6 of 8 comments rated"),
    ).toBeInTheDocument();
  });

  it("says a review with no comments has nothing to rate", async () => {
    withScores(fixtureEvalNoComments);
    renderDetail(fixtureReviewApproved.id);

    const region = await rating();
    expect(await within(region).findByText("Nothing to rate.")).toBeInTheDocument();
    // Distinct from unrated, which is an invitation to go and rate something.
    expect(within(region).queryByText(/no ratings yet/i)).not.toBeInTheDocument();
  });

  it("marks a rate above §8.1's target as meeting it", async () => {
    withScores(fixtureEvalRated);
    renderDetail(fixtureReviewCompleted.id);

    expect(
      await within(await rating()).findByText("Meets target"),
    ).toBeInTheDocument();
  });

  it("marks a rate below §8.1's target as missing it", async () => {
    withScores(fixtureEvalBelowTarget);
    renderDetail(fixtureReviewCompleted.id);

    expect(
      await within(await rating()).findByText("Below target"),
    ).toBeInTheDocument();
  });

  /**
   * §8.1 asks for *more than* 70%, so exactly 70% is a miss. Asserted because
   * `>=` is the easier thing to type and no other fixture here would catch it.
   */
  it("treats exactly the target as missing it", async () => {
    withScores({
      ...fixtureEvalRated,
      approval_rate: 0.7,
      false_positive_rate: 0.3,
    });
    renderDetail(fixtureReviewCompleted.id);

    expect(
      await within(await rating()).findByText("Below target"),
    ).toBeInTheDocument();
  });

  it("does not fetch eval scores for a processing review", async () => {
    let fetched = 0;
    server.use(
      http.get("*/reviews/:reviewId/eval", () => {
        fetched += 1;
        return HttpResponse.json(fixtureEvalUnrated);
      }),
    );
    renderDetail(fixtureReviewProcessing.id);

    await screen.findByRole("region", { name: "Review progress" });
    expect(screen.queryByRole("region", { name: "Rating" })).not.toBeInTheDocument();
    expect(fetched).toBe(0);
  });

  /**
   * The invalidation wiring, end to end. The eval key nests under the detail
   * key, so #198's `onSettled` reaches it by prefix without either side
   * knowing the other exists — and the mock recomputes the rate from the
   * ratings it has been sent, so this is a real recomputation rather than two
   * fixtures agreeing with each other.
   *
   * The completed fixture starts at 1 of 2 rated, that one positive: 100%.
   * Rating the other comment down takes it to 2 of 2, one positive: 50%.
   */
  it("updates the approval rate after a comment is rated", async () => {
    const user = userEvent.setup();
    renderDetail(fixtureReviewCompleted.id);

    expect(await within(await rating()).findByText("100%")).toBeInTheDocument();

    const comments = screen.getByRole("region", { name: "Comments" });
    // Worst-first: card 0 is the already-rated critical, card 1 the unrated.
    const [, unrated] = within(comments).getAllByRole("article");
    await user.click(within(unrated).getByRole("button", { name: "Not helpful" }));

    const region = await rating();
    expect(await within(region).findByText("50%")).toBeInTheDocument();
    expect(within(region).getByText("2 of 2 comments rated")).toBeInTheDocument();
  });

  /** A score that failed to load must not cost the reader the review. */
  it("keeps the rest of the page when the eval fetch fails", async () => {
    server.use(
      http.get("*/reviews/:reviewId/eval", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    renderDetail(fixtureReviewCompleted.id);

    expect(
      await within(await rating()).findByText(
        "Couldn't load the rating for this review.",
      ),
    ).toBeInTheDocument();
    // The findings themselves are untouched by a failed score fetch.
    expect(screen.getByRole("region", { name: "Comments" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Comments" })).getAllByRole("article"),
    ).toHaveLength(fixtureReviewCompleted.comments.length);
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
