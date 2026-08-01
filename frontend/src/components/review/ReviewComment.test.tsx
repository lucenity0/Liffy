import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import { renderWithProviders } from "@/test/renderWithProviders";
import type { ReviewCommentOut } from "@/types/api";
import { ReviewComment } from "./ReviewComment";

const REVIEW_ID = "bbbbbbbb-0000-0000-0000-000000000001";

function makeComment(overrides: Partial<ReviewCommentOut> = {}): ReviewCommentOut {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    file_path: "src/lib/diff.ts",
    line_start: 42,
    line_end: 42,
    category: "logic_error",
    severity: "critical",
    comment_text: "This desyncs every line number after a countless hunk.",
    suggestion: null,
    created_at: "2026-07-25T14:32:10Z",
    my_rating: null,
    ...overrides,
  };
}

/**
 * Rendered without the review-detail query behind it, so the cache holds
 * nothing for `useCommentFeedback` to write into and `my_rating` stays
 * whatever the prop says. That is the point of the split: these tests are
 * about the control and what it sends, and the optimistic cache write is
 * proven in hooks.test.tsx and ReviewDetail.test.tsx where there is a real
 * cache entry to move.
 */
function renderComment(comment: ReviewCommentOut = makeComment()) {
  renderWithProviders(<ReviewComment comment={comment} reviewId={REVIEW_ID} />);
  return { user: userEvent.setup() };
}

const up = () => screen.getByRole("button", { name: "Helpful" });
const down = () => screen.getByRole("button", { name: "Not helpful" });

/** Captures every feedback POST body, in order. */
function recordRatings() {
  const sent: unknown[] = [];
  server.use(
    http.post("*/comments/:commentId/feedback", async ({ params, request }) => {
      const body = (await request.json()) as { rating: number };
      sent.push(body);
      return HttpResponse.json({
        comment_id: params.commentId,
        rating: body.rating,
        created_at: "2026-07-25T14:40:00Z",
      });
    }),
  );
  return sent;
}

describe("ReviewComment — rating control", () => {
  /**
   * An icon is not an accessible name. Both buttons are glyph-only, so
   * without `aria-label` a screen reader announces "button" twice and the
   * user has no way to tell which thumb is which.
   */
  it("renders both rating buttons with accessible names", () => {
    renderComment();

    expect(up()).toBeInTheDocument();
    expect(down()).toBeInTheDocument();
  });

  /**
   * `aria-pressed`, not a class. A colour change tells assistive tech
   * nothing, and asserting the class would pass even if the attribute were
   * dropped — which is the regression that actually matters here.
   */
  it("shows the up button pressed when my_rating is 1", () => {
    renderComment(makeComment({ my_rating: 1 }));

    expect(up()).toHaveAttribute("aria-pressed", "true");
    expect(down()).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the down button pressed when my_rating is -1", () => {
    renderComment(makeComment({ my_rating: -1 }));

    expect(up()).toHaveAttribute("aria-pressed", "false");
    expect(down()).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * The state most comments are in. Both buttons still carry the attribute —
   * omitting it on the unpressed side would make them read as plain buttons
   * rather than as a toggle that happens to be off.
   */
  it("shows neither pressed when my_rating is null", () => {
    renderComment();

    expect(up()).toHaveAttribute("aria-pressed", "false");
    expect(down()).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking up sends rating 1", async () => {
    const sent = recordRatings();
    const { user } = renderComment();

    await user.click(up());

    await waitFor(() => expect(sent).toEqual([{ rating: 1 }]));
  });

  it("clicking down sends rating -1", async () => {
    const sent = recordRatings();
    const { user } = renderComment();

    await user.click(down());

    await waitFor(() => expect(sent).toEqual([{ rating: -1 }]));
  });

  /**
   * The API would accept it — re-rating replaces — but it is a write that
   * cannot change anything, and it would flash the disabled state for a
   * round trip that was never needed.
   */
  it("clicking the already-selected side does not fire a request", async () => {
    const sent = recordRatings();
    const { user } = renderComment(makeComment({ my_rating: 1 }));

    await user.click(up());

    expect(sent).toEqual([]);
  });

  /**
   * Switching sides is one POST, not an un-rate followed by a rate — #190
   * made re-rating replace the row precisely so this stays a single write.
   */
  it("clicking the opposite side switches with a single request", async () => {
    const sent = recordRatings();
    const { user } = renderComment(makeComment({ my_rating: 1 }));

    await user.click(down());

    await waitFor(() => expect(sent).toEqual([{ rating: -1 }]));
  });

  /**
   * Both, not just the one clicked — a second rating racing the first would
   * settle in whichever order the network felt like.
   *
   * `aria-disabled`, not `disabled`: a real `disabled` moves focus to
   * `<body>`, which would eject a keyboard user to the top of the page every
   * time they rate something. The buttons therefore stay clickable and the
   * no-op lives in the handler, which the last assertion here pins.
   */
  it("marks both buttons busy and ignores clicks while in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: unknown[] = [];
    server.use(
      http.post("*/comments/:commentId/feedback", async ({ params, request }) => {
        sent.push(await request.json());
        await gate;
        return HttpResponse.json({
          comment_id: params.commentId,
          rating: 1,
          created_at: "2026-07-25T14:40:00Z",
        });
      }),
    );
    const { user } = renderComment();

    await user.click(up());

    await waitFor(() => expect(up()).toHaveAttribute("aria-disabled", "true"));
    expect(down()).toHaveAttribute("aria-disabled", "true");
    expect(up()).toHaveFocus();

    // Clickable, but inert — one request, not two.
    await user.click(down());
    expect(sent).toHaveLength(1);

    release();
    await waitFor(() => expect(up()).toHaveAttribute("aria-disabled", "false"));
  });

  /**
   * Eight of these render on the fixture review. If the thumbs were divs with
   * click handlers they would be unreachable by keyboard and invisible to the
   * tab order — this asserts they are real buttons that Enter activates, and
   * that rating one does not cost you your place in the page.
   */
  it("is reachable and activatable by keyboard, and keeps focus", async () => {
    const sent = recordRatings();
    const { user } = renderComment();

    await user.tab();
    expect(up()).toHaveFocus();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent).toEqual([{ rating: 1 }]));
    expect(up()).toHaveFocus();

    await user.tab();
    expect(down()).toHaveFocus();
  });

  /**
   * `normalizeApiError`'s 422 branch says "That doesn't look like
   * owner/name." — copy written for the connect-repo form. It must not reach
   * a thumbs-up, and asserting its absence is what stops someone dropping the
   * local override later.
   */
  it("surfaces a failure without the connect-repo copy", async () => {
    server.use(
      http.post("*/comments/:commentId/feedback", () =>
        HttpResponse.json(
          { detail: [{ type: "literal_error", loc: ["body", "rating"] }] },
          { status: 422 },
        ),
      ),
    );
    const { user } = renderComment();

    await user.click(up());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save that rating.");
    expect(alert).not.toHaveTextContent(/owner\/name/);
  });
});
