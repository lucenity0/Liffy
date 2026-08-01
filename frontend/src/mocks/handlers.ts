import { http, HttpResponse } from "msw";
import {
  fixtureAnalyticsSummary,
  fixtureRepoIndexed,
  fixtureRepoStatusIndexed,
  fixtureRepoStatusNotIndexed,
  fixtureRepos,
  fixtureReviewDetailById,
  fixtureReviewListItems,
  fixtureTokenPair,
  fixtureUser,
} from "./fixtures";
import { REVIEW_STATUSES, type ReviewDetailOut } from "@/types/api";

/**
 * Wildcard path matching (a leading "*" instead of a full origin) so the
 * same handlers work whether VITE_API_BASE_URL points at localhost:8000 or a
 * dev-server proxy path.
 *
 * `onUnhandledRequest` is set to "error" for Node (setupServer, in tests) so
 * a typo'd URL fails loudly, and "bypass" for the browser worker — see
 * mocks/browser.ts, where a strict mode would spam the console over Vite's
 * own HMR and font requests.
 */

const FULL_NAME_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Ratings recorded by the feedback POST, keyed by comment id.
 *
 * Stateful on purpose, and the only handler here that is. `useCommentFeedback`
 * invalidates the review detail on settle, so a handler that replayed the
 * frozen fixture would answer that refetch with the *old* `my_rating` — the
 * thumb would un-press a beat after being clicked. In `dev:mock` that reads as
 * broken, and a test asserting the rating stuck would be asserting a fiction.
 *
 * One entry per comment, replaced rather than appended, mirroring the unique
 * `(comment_id, user_id)` row the real backend keeps.
 */
const ratings = new Map<string, number>();

/**
 * Wired into setupTests' `afterEach` alongside `server.resetHandlers()`,
 * which restores handler *definitions* and knows nothing about this map — so
 * without it one test's thumbs-up leaks into the next test's fixtures.
 */
export function resetFeedback() {
  ratings.clear();
}

/** The detail fixtures are shared module constants: overlay, never mutate. */
function withRatings(review: ReviewDetailOut): ReviewDetailOut {
  return {
    ...review,
    comments: review.comments.map((comment) => {
      const rating = ratings.get(comment.id);
      return rating === undefined ? comment : { ...comment, my_rating: rating };
    }),
  };
}

export const handlers = [
  http.get("*/repos", () => HttpResponse.json(fixtureRepos)),

  http.post("*/repos", async ({ request }) => {
    const body = (await request.json()) as { full_name?: string };
    const fullName = body.full_name?.trim();

    if (!fullName || !FULL_NAME_RE.test(fullName)) {
      return HttpResponse.json(
        { detail: "full_name must look like owner/name" },
        { status: 422 },
      );
    }
    if (fullName === "nonexistent/nope") {
      return HttpResponse.json(
        { detail: "GitHub couldn't find that repository" },
        { status: 502 },
      );
    }
    if (fullName === "no-token/repo") {
      return HttpResponse.json(
        { detail: "Server has no GitHub token configured" },
        { status: 503 },
      );
    }

    return HttpResponse.json(
      {
        id: "33333333-3333-3333-3333-333333333333",
        full_name: fullName,
        default_branch: "main",
        indexed_at: null,
        created_at: new Date(0).toISOString(),
      },
      { status: 201 },
    );
  }),

  http.delete("*/repos/:repoId", () => new HttpResponse(null, { status: 204 })),

  http.post("*/repos/:repoId/index", ({ params }) =>
    HttpResponse.json(
      { repo_id: params.repoId, status: "queued" },
      { status: 202 },
    ),
  ),

  http.get("*/repos/:repoId/status", ({ params }) => {
    if (params.repoId === fixtureRepoIndexed.id) {
      return HttpResponse.json(fixtureRepoStatusIndexed);
    }
    return HttpResponse.json(fixtureRepoStatusNotIndexed);
  }),

  /**
   * Filters and sorts for real rather than echoing the fixture back.
   *
   * A handler that accepted the parameters and ignored them would make a
   * broken filter look like a working one — every test would pass, `dev:mock`
   * would look right, and the bug would surface only against the real API.
   * So this mirrors `list_reviews`: narrow, then count, then slice, and 422 on
   * the same inputs the backend rejects.
   *
   * `repo_id` is resolved through `fixtureRepos` because a `ReviewListItem`
   * carries `repo_full_name`, not the id — the real endpoint has the id in
   * hand from the join it already performed, and this is the closest a flat
   * fixture gets to that.
   */
  http.get("*/reviews", ({ request }) => {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const repoId = url.searchParams.get("repo_id");
    const prNumber = url.searchParams.get("pr_number");
    const status = url.searchParams.get("status");
    const sort = url.searchParams.get("sort") ?? "newest";

    if (limit < 1 || limit > 100 || offset < 0) {
      return HttpResponse.json({ detail: "invalid pagination" }, { status: 422 });
    }
    if (sort !== "newest" && sort !== "oldest") {
      return HttpResponse.json({ detail: "invalid sort" }, { status: 422 });
    }
    if (status !== null && !(REVIEW_STATUSES as readonly string[]).includes(status)) {
      return HttpResponse.json({ detail: "invalid status" }, { status: 422 });
    }

    const repoFullName = repoId
      ? fixtureRepos.find((repo) => repo.id === repoId)?.full_name
      : undefined;

    let matched = fixtureReviewListItems;
    if (repoId) {
      // An unknown repo id matches nothing — which is also what the backend
      // does for another user's repo, and the two must not look different.
      matched = matched.filter((r) => r.repo_full_name === repoFullName);
    }
    if (prNumber) {
      matched = matched.filter((r) => r.pr_number === Number(prNumber));
    }
    if (status) {
      matched = matched.filter((r) => r.status === status);
    }

    // The fixture array is not in date order, so this cannot be a reverse():
    // the default has to be a real sort or "newest" is a lie the tests believe.
    const sorted = [...matched].sort((a, b) => {
      const delta = Date.parse(a.created_at) - Date.parse(b.created_at);
      return sort === "oldest" ? delta : -delta;
    });

    // `total` counts the filtered set, before the window — the whole point of
    // the envelope.
    return HttpResponse.json({
      items: sorted.slice(offset, offset + limit),
      total: sorted.length,
    });
  }),

  http.get("*/reviews/:reviewId", ({ params }) => {
    const review = fixtureReviewDetailById[params.reviewId as string];
    if (!review) {
      return HttpResponse.json({ detail: "Review not found" }, { status: 404 });
    }
    return HttpResponse.json(withRatings(review));
  }),

  /**
   * Derived from the same ratings the feedback POST records, rather than a
   * canned payload. That is what makes "rating a comment moves the number" a
   * real assertion here instead of two fixtures agreeing with each other.
   *
   * `my_rating` is the *caller's* rating and `approval_rate` is across all
   * users, so equating them is a simplification the real backend does not
   * make — harmless at one mock user, and the alternative is a fixture that
   * cannot respond to a click.
   */
  http.get("*/reviews/:reviewId/eval", ({ params }) => {
    const review = fixtureReviewDetailById[params.reviewId as string];
    if (!review) {
      return HttpResponse.json({ detail: "Review not found" }, { status: 404 });
    }

    const comments = withRatings(review).comments;
    const rated = comments.filter((comment) => comment.my_rating !== null);
    const approval =
      // null, not 0 — nobody has rated is not everybody disapproved.
      rated.length === 0
        ? null
        : rated.filter((comment) => comment.my_rating === 1).length /
          rated.length;

    return HttpResponse.json({
      review_id: review.id,
      total_comments: comments.length,
      rated_comments: rated.length,
      approval_rate: approval,
      false_positive_rate: approval === null ? null : 1 - approval,
    });
  }),

  http.get("*/prs/:prId/review", ({ params }) => {
    const review = Object.values(fixtureReviewDetailById).find(
      (r) => r.pr_id === params.prId,
    );
    if (!review) {
      return HttpResponse.json(
        { detail: "No review for this pull request" },
        { status: 404 },
      );
    }
    return HttpResponse.json(withRatings(review));
  }),

  http.post("*/reviews/trigger", async ({ request }) => {
    const body = (await request.json()) as {
      owner?: string;
      repo?: string;
      pr_number?: number;
    };
    if (!body.owner || !body.repo || !body.pr_number || body.pr_number < 1) {
      return HttpResponse.json({ detail: "invalid trigger payload" }, { status: 422 });
    }
    return HttpResponse.json(
      { status: "queued", repo: `${body.owner}/${body.repo}`, pr_number: body.pr_number },
      { status: 202 },
    );
  }),

  http.post("*/reviews/:reviewId/trigger", ({ params }) => {
    const review = fixtureReviewDetailById[params.reviewId as string];
    if (!review) {
      return HttpResponse.json({ detail: "Review not found" }, { status: 404 });
    }
    return HttpResponse.json(
      { status: "queued", repo: "lucenity0/Liffy", pr_number: 58 },
      { status: 202 },
    );
  }),

  // The populated state by default. The partial and empty states are what
  // #200's page mostly renders, but a default of "nothing measured" would
  // make every unrelated test that wanders onto this page assert against
  // dashes.
  http.get("*/analytics/summary", () =>
    HttpResponse.json(fixtureAnalyticsSummary),
  ),

  // ── Auth ───────────────────────────────────────────────────────────────────
  // Happy-path defaults. The interesting auth cases (a refresh that 401s,
  // endpoints that 401 until refreshed) are per-test `server.use` overrides —
  // baking them in here would make every unrelated test authenticate.

  http.get("*/auth/me", ({ request }) => {
    if (!request.headers.get("Authorization")) {
      return HttpResponse.json({ detail: "Not authenticated" }, { status: 401 });
    }
    return HttpResponse.json(fixtureUser);
  }),

  http.post("*/auth/refresh", async ({ request }) => {
    const body = (await request.json()) as { refresh_token?: string };
    if (!body.refresh_token) {
      return HttpResponse.json({ detail: "Invalid refresh token" }, { status: 401 });
    }
    return HttpResponse.json(fixtureTokenPair);
  }),

  http.post("*/auth/logout", () => new HttpResponse(null, { status: 204 })),

  // Mirrors the real contract as of #190: a bad rating is a 422 with FastAPI's
  // array-shaped `detail`, not a 200 carrying a status field. The old stub
  // answered 200 either way, so a test written against it would have passed
  // against a fiction.
  http.post("*/comments/:commentId/feedback", async ({ params, request }) => {
    const body = (await request.json()) as { rating?: number };
    if (body.rating !== 1 && body.rating !== -1) {
      return HttpResponse.json(
        {
          detail: [
            {
              type: "literal_error",
              loc: ["body", "rating"],
              msg: "Input should be 1 or -1",
            },
          ],
        },
        { status: 422 },
      );
    }
    ratings.set(params.commentId as string, body.rating);
    return HttpResponse.json({
      comment_id: params.commentId,
      rating: body.rating,
      // The row's *original* creation time on the real API — re-rating
      // replaces `rating` and leaves this alone, since `comment_feedback` has
      // no `updated_at` by design. Close enough here: nothing renders it.
      created_at: new Date().toISOString(),
    });
  }),
];
