import { http, HttpResponse } from "msw";
import {
  fixtureAnalyticsSummary,
  fixtureHelpPassages,
  fixtureHelpTopics,
  fixtureRepoIndexed,
  fixtureRepoStatusIndexed,
  fixtureRepoStatusNotIndexed,
  fixtureRepos,
  fixtureReviewDetailById,
  fixtureReviewListItems,
  fixtureSettings,
  fixtureTokenPair,
  fixtureUser,
} from "./fixtures";
import type { ReviewDetailOut, SettingsOut } from "@/types/api";

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

/**
 * The settings document the PATCH handler mutates.
 *
 * Stateful for the same reason `ratings` is: `useUpdateSettings` writes the
 * response into the cache, so a handler replaying the frozen fixture would
 * answer a save with the old value and the control would snap back a beat
 * after being changed.
 *
 * Cloned from the fixture rather than aliasing it, so a test that saves a
 * setting cannot edit the shared constant every other test reads.
 */
let settingsState: SettingsOut = structuredClone(fixtureSettings);

/**
 * Secrets this mock pretends `backend/.env` also sets.
 *
 * Disconnect deletes Liffy's stored copy and the dotfile's value takes over —
 * which is the case the UI got wrong: it read as "still connected", so the
 * button appeared to do nothing. Modelling the file here is what lets a test
 * tell the two apart.
 */
const dotenvSecrets = new Set<string>();

/** Put a secret in the mock's `.env`. Cleared by `resetSettings`. */
export function setDotenvSecret(key: string) {
  dotenvSecrets.add(key);
}

/** Wired into setupTests' `afterEach`, alongside `resetFeedback`. */
export function resetSettings() {
  settingsState = structuredClone(fixtureSettings);
  dotenvSecrets.clear();
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

  http.get("*/settings", () => HttpResponse.json(settingsState)),

  /**
   * Stateful, like the ratings handler above and for the same reason: the
   * mutation writes the response straight into the cache, so a handler
   * replaying the frozen fixture would answer a save with the *old* value and
   * the control would snap back a beat after being changed.
   *
   * It also enforces the allowlist and the validation, so `dev:mock` cannot
   * make an impossible write look like it worked.
   */
  http.patch("*/settings", async ({ request }) => {
    const { values } = (await request.json()) as {
      values: Record<string, string>;
    };

    const next = structuredClone(settingsState);
    for (const [key, raw] of Object.entries(values)) {
      const target = next.editable.find((entry) => entry.key === key);
      if (!target) {
        return HttpResponse.json(
          { detail: `'${key}' is not an editable setting.` },
          { status: 422 },
        );
      }
      if (target.kind === "choice" && !target.choices.includes(raw)) {
        return HttpResponse.json(
          { detail: `Must be one of: ${target.choices.join(", ")}.` },
          { status: 422 },
        );
      }
      if (target.kind === "int") {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed)) {
          return HttpResponse.json(
            { detail: `Expected a whole number, got '${raw}'.` },
            { status: 422 },
          );
        }
        if (target.minimum !== null && parsed < target.minimum) {
          return HttpResponse.json(
            { detail: `Must be at least ${target.minimum}.` },
            { status: 422 },
          );
        }
        target.value = parsed;
      } else if (target.kind === "bool") {
        target.value = raw === "true";
      } else {
        target.value = raw;
      }
      // Back to its default means no override — the same rule the resolver
      // applies by deleting the row.
      target.source = target.value === target.default_value ? "default" : "override";
    }

    settingsState = next;
    return HttpResponse.json(settingsState);
  }),

  /**
   * Connecting a credential from the page.
   *
   * Enforces the two rules that matter, so `dev:mock` cannot make a forbidden
   * write look like it worked: only `connectable` keys are accepted, and the
   * value is never echoed back into the document.
   */
  http.post("*/settings/secrets/:key", async ({ params, request }) => {
    const { value } = (await request.json()) as { value: string };
    const next = structuredClone(settingsState);
    const target = next.secrets.find((entry) => entry.key === params.key);

    if (!target?.connectable) {
      return HttpResponse.json(
        { detail: `'${params.key}' cannot be connected from the settings page.` },
        { status: 422 },
      );
    }
    if (value.trim().length < 20 || /\s/.test(value.trim())) {
      return HttpResponse.json(
        { detail: "That does not look like a token." },
        { status: 422 },
      );
    }

    target.is_set = true;
    target.source = "override";
    settingsState = next;
    return HttpResponse.json(settingsState);
  }),

  http.delete("*/settings/secrets/:key", ({ params }) => {
    const next = structuredClone(settingsState);
    const target = next.secrets.find((entry) => entry.key === params.key);
    if (!target?.connectable) {
      return HttpResponse.json(
        { detail: `'${params.key}' is not a connected credential.` },
        { status: 422 },
      );
    }
    // Disconnect drops Liffy's copy; whatever `.env` holds takes over again.
    // `dotenvSecrets` is what the real backend re-reads from settings — here it
    // stands in for the file, so the fallback is exercised rather than assumed.
    const fromDotenv = dotenvSecrets.has(String(params.key));
    target.is_set = fromDotenv;
    target.source = fromDotenv ? "env" : "default";
    settingsState = next;
    return HttpResponse.json(settingsState);
  }),

  // ── Help (#237) ────────────────────────────────────────────────────────────
  //
  // Ranking is the backend's, and is tested there. This mock does the one
  // thing the UI actually branches on: a query either matches something or it
  // matches nothing, and "nothing" must be a 200 with an empty list rather
  // than an error.
  http.get("*/help/topics", () => HttpResponse.json(fixtureHelpTopics)),

  // Liffy files the issue itself now, so the mock owns the receipt the form
  // renders. 422 for a short title mirrors the backend's own validation.
  http.post("*/help/report", async ({ request }) => {
    const body = (await request.json()) as {
      title?: string;
      body?: string;
      kind?: string;
    };
    if (body.kind === "security") {
      return HttpResponse.json(
        { detail: "security reports do not go in public issues" },
        { status: 422 },
      );
    }
    if ((body.title ?? "").trim().length < 3 || (body.body ?? "").trim().length < 10) {
      return HttpResponse.json({ detail: "too short" }, { status: 422 });
    }
    return HttpResponse.json(
      { number: 251, url: "https://github.com/lucenity0/Liffy/issues/251" },
      { status: 201 },
    );
  }),

  http.get("*/help/:slug", ({ params }) => {
    const page = fixtureHelpPassages.find((p) => p.slug === params.slug);
    return HttpResponse.json(page ?? null);
  }),

  http.get("*/help", ({ request }) => {
    const q = (new URL(request.url).searchParams.get("q") ?? "").toLowerCase();
    const results = q.trim()
      ? fixtureHelpPassages.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            p.snippet.toLowerCase().includes(q) ||
            q.split(/\s+/).some((t) => t.length > 3 && p.body.toLowerCase().includes(t)),
        )
      : [];
    return HttpResponse.json({ query: q, results });
  }),
];
