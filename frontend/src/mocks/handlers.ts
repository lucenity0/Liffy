import { http, HttpResponse } from "msw";
import {
  fixtureRepoIndexed,
  fixtureRepoStatusIndexed,
  fixtureRepoStatusNotIndexed,
  fixtureRepos,
  fixtureReviewDetailById,
  fixtureReviewListItems,
  fixtureTokenPair,
  fixtureUser,
} from "./fixtures";
import type { ReviewDetailOut } from "@/types/api";

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

  http.get("*/reviews", ({ request }) => {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    if (limit < 1 || limit > 100 || offset < 0) {
      return HttpResponse.json({ detail: "invalid pagination" }, { status: 422 });
    }

    return HttpResponse.json(fixtureReviewListItems.slice(offset, offset + limit));
  }),

  http.get("*/reviews/:reviewId", ({ params }) => {
    const review = fixtureReviewDetailById[params.reviewId as string];
    if (!review) {
      return HttpResponse.json({ detail: "Review not found" }, { status: 404 });
    }
    return HttpResponse.json(withRatings(review));
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
