import type {
  AnalyticsSummaryOut,
  EvalScoresOut,
  RepoOut,
  RepoStatusOut,
  ReviewCommentOut,
  ReviewDetailOut,
  ReviewListItem,
  TokenPair,
  UserOut,
} from "@/types/api";

/**
 * Shared fixtures for MSW handlers and component tests. Timestamps carry an
 * explicit `Z` — see `ensureUtc` in lib/utils.ts for why that matters.
 */

export const fixtureRepoIndexed: RepoOut = {
  id: "11111111-1111-1111-1111-111111111111",
  full_name: "lucenity0/Liffy",
  default_branch: "main",
  indexed_at: "2026-07-20T10:00:00Z",
  created_at: "2026-07-01T09:00:00Z",
};

export const fixtureRepoIndexing: RepoOut = {
  id: "22222222-2222-2222-2222-222222222222",
  full_name: "lucenity0/portfolio",
  default_branch: "main",
  indexed_at: null,
  created_at: "2026-07-24T12:00:00Z",
};

export const fixtureRepos: RepoOut[] = [fixtureRepoIndexed, fixtureRepoIndexing];

export const fixtureRepoStatusIndexed: RepoStatusOut = {
  id: fixtureRepoIndexed.id,
  full_name: fixtureRepoIndexed.full_name,
  status: "indexed",
  indexed_at: fixtureRepoIndexed.indexed_at,
  chunk_count: 176,
  // A clean run: measured, nothing failed. The chip carries no caveat.
  last_index_failed_files: 0,
  last_indexed_files_seen: 142,
};

export const fixtureRepoStatusNotIndexed: RepoStatusOut = {
  id: fixtureRepoIndexing.id,
  full_name: fixtureRepoIndexing.full_name,
  status: "not_indexed",
  indexed_at: null,
  chunk_count: 0,
  last_index_failed_files: null,
  last_indexed_files_seen: null,
};

/** A run that succeeded but left holes — #210's whole reason for existing. */
export const fixtureRepoStatusPartial: RepoStatusOut = {
  ...fixtureRepoStatusIndexed,
  chunk_count: 160,
  last_index_failed_files: 40,
  last_indexed_files_seen: 200,
};

/** Indexed before the counters existed: null, not zero. */
export const fixtureRepoStatusLegacy: RepoStatusOut = {
  ...fixtureRepoStatusIndexed,
  last_index_failed_files: null,
  last_indexed_files_seen: null,
};

const fixtureComment: ReviewCommentOut = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  file_path: "setup-mac.sh",
  line_start: 1,
  line_end: 5,
  category: "improvement",
  severity: "info",
  comment_text:
    "Consider quoting $HOME here — unquoted expansion works today but will break the moment this script runs under a path with a space in it.",
  suggestion: 'BREW_PREFIX="$HOME/.brew"',
  created_at: "2026-07-25T14:32:10Z",
  // Unrated — the state most comments are in, and the one #198's control has
  // to look right in.
  my_rating: null,
};

const fixtureCommentCritical: ReviewCommentOut = {
  id: "aaaaaaaa-0000-0000-0000-000000000002",
  file_path: "src/lib/diff.ts",
  line_start: 42,
  line_end: 44,
  category: "logic_error",
  severity: "critical",
  comment_text:
    "This assumes every hunk has an explicit line count, but the unified diff format allows omitting it (defaults to 1). As written, a single-line hunk will desync every line number after it.",
  suggestion: "const count = match[2] === undefined ? 1 : Number(match[2]);",
  created_at: "2026-07-25T14:32:11Z",
  // Already rated, so the pressed state has something to render against
  // without a test having to POST first.
  my_rating: 1,
};

export const fixtureReviewCompleted: ReviewDetailOut = {
  id: "bbbbbbbb-0000-0000-0000-000000000001",
  pr_id: "cccccccc-0000-0000-0000-000000000001",
  pr_number: 58,
  repo_full_name: "lucenity0/Liffy",
  status: "completed",
  summary:
    "One thing worth fixing before this merges: the diff-hunk parser assumes an explicit line count on every hunk header, but the format allows omitting it. Everything else — the setup script, the retry logic — reads cleanly.",
  verdict: "request_changes",
  model_used: "gpt-4o",
  tokens_used: 4213,
  duration_ms: 41200,
  // Receipt to completion: 2m17s, so this fixture *misses* §8.1's < 90s
  // target. Deliberately kept — the span was already 135s before METRIC-2, and
  // a fixture that exercises the miss case is worth more than one that quietly
  // passes. Queue wait here is total_ms - duration_ms = 95.8s.
  total_ms: 137000,
  created_at: "2026-07-25T14:30:00Z",
  queued_at: "2026-07-25T14:29:58Z",
  completed_at: "2026-07-25T14:32:15Z",
  comments: [fixtureCommentCritical, fixtureComment],
  raw_diff: `diff --git a/setup-mac.sh b/setup-mac.sh
--- a/setup-mac.sh
+++ b/setup-mac.sh
@@ -1,5 +1,5 @@
-BREW_PREFIX=$HOME/.brew
+BREW_PREFIX=$HOME/.brew
 export PATH="$BREW_PREFIX/bin:$PATH"

 echo "Installing dependencies..."
diff --git a/src/lib/diff.ts b/src/lib/diff.ts
--- a/src/lib/diff.ts
+++ b/src/lib/diff.ts
@@ -40,7 +40,9 @@ function parseHunkHeader(line: string): HunkHeader {
   const match = HUNK_HEADER_RE.exec(line);
   if (!match) throw new Error("Malformed hunk header");
-  const count = Number(match[2]);
+  const count = match[2] === undefined ? 1 : Number(match[2]);
   return { start: Number(match[1]), count };
 }
`,
};

export const fixtureReviewApproved: ReviewDetailOut = {
  id: "bbbbbbbb-0000-0000-0000-000000000002",
  pr_id: "cccccccc-0000-0000-0000-000000000002",
  pr_number: 59,
  repo_full_name: "lucenity0/portfolio",
  status: "completed",
  summary: "Clean change. No issues found.",
  verdict: "approve",
  model_used: "gpt-4o",
  tokens_used: 1802,
  duration_ms: 18400,
  total_ms: 102000,
  created_at: "2026-07-24T09:00:00Z",
  queued_at: "2026-07-24T08:59:58Z",
  completed_at: "2026-07-24T09:01:40Z",
  comments: [],
  raw_diff: "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
};

export const fixtureReviewPending: ReviewDetailOut = {
  id: "bbbbbbbb-0000-0000-0000-000000000003",
  pr_id: "cccccccc-0000-0000-0000-000000000003",
  pr_number: 62,
  repo_full_name: "lucenity0/Liffy",
  status: "pending",
  summary: null,
  verdict: null,
  model_used: null,
  tokens_used: null,
  duration_ms: null,
  // Queued but not finished: the receipt exists, the end-to-end figure cannot
  // yet. This is the shape every in-flight review has.
  total_ms: null,
  created_at: "2026-07-26T08:00:00Z",
  queued_at: "2026-07-26T07:59:58Z",
  completed_at: null,
  comments: [],
  raw_diff: null,
};

export const fixtureReviewProcessing: ReviewDetailOut = {
  ...fixtureReviewPending,
  id: "bbbbbbbb-0000-0000-0000-000000000004",
  pr_id: "cccccccc-0000-0000-0000-000000000004",
  pr_number: 60,
  status: "processing",
};

export const fixtureReviewFailed: ReviewDetailOut = {
  id: "bbbbbbbb-0000-0000-0000-000000000005",
  pr_id: "cccccccc-0000-0000-0000-000000000005",
  pr_number: 61,
  repo_full_name: "lucenity0/Liffy",
  status: "failed",
  summary: null,
  verdict: null,
  model_used: "gpt-4o",
  tokens_used: null,
  // A failed review still reports how long it took to fail — that is the
  // most useful row in the table when something is going wrong, and matching
  // completed_at - created_at here keeps the fixture internally consistent.
  duration_ms: 42000,
  // And how long it took end to end, for the same reason: the failure path
  // records both.
  total_ms: 45000,
  created_at: "2026-07-23T11:00:00Z",
  queued_at: "2026-07-23T10:59:57Z",
  completed_at: "2026-07-23T11:00:42Z",
  comments: [],
  raw_diff: null,
};

/**
 * The list item is the detail minus the two heavy fields. Since #136 put
 * pr_number and repo_full_name on the detail too, this no longer needs them
 * passed in — which also means the two fixtures can never disagree about
 * which PR a review belongs to.
 */
const detailToListItem = (review: ReviewDetailOut): ReviewListItem => ({
  id: review.id,
  pr_id: review.pr_id,
  pr_number: review.pr_number,
  repo_full_name: review.repo_full_name,
  status: review.status,
  summary: review.summary,
  verdict: review.verdict,
  model_used: review.model_used,
  tokens_used: review.tokens_used,
  duration_ms: review.duration_ms,
  total_ms: review.total_ms,
  created_at: review.created_at,
  queued_at: review.queued_at,
  completed_at: review.completed_at,
});

export const fixtureReviewListItems: ReviewListItem[] = [
  detailToListItem(fixtureReviewFailed),
  detailToListItem(fixtureReviewProcessing),
  detailToListItem(fixtureReviewApproved),
  detailToListItem(fixtureReviewCompleted),
];

export const fixtureReviewDetailById: Record<string, ReviewDetailOut> = {
  [fixtureReviewCompleted.id]: fixtureReviewCompleted,
  [fixtureReviewApproved.id]: fixtureReviewApproved,
  [fixtureReviewPending.id]: fixtureReviewPending,
  [fixtureReviewProcessing.id]: fixtureReviewProcessing,
  [fixtureReviewFailed.id]: fixtureReviewFailed,
};

// ── Auth ─────────────────────────────────────────────────────────────────────

export const fixtureUser: UserOut = {
  id: "44444444-4444-4444-4444-444444444444",
  github_id: 1837423,
  username: "lucenity0",
  email: "dev@example.com",
  avatar_url: "https://avatars.githubusercontent.com/u/1837423?v=4",
};

/** No avatar — the initials-fallback case AUTH-8 has to render. */
export const fixtureUserNoAvatar: UserOut = {
  ...fixtureUser,
  id: "55555555-5555-5555-5555-555555555555",
  username: "gajalakshmishashir",
  email: null,
  avatar_url: null,
};

/**
 * The three shapes `GET /reviews/{id}/eval` can come back in.
 *
 * The default handler *derives* the scores from whatever has been rated, so
 * a test that wants a particular one of these states pins it with
 * `server.use` rather than hunting for a review that happens to be in it.
 * Kept here so the three read side by side — the distinctions between them
 * are the entire subject of #199.
 */
export const fixtureEvalRated: EvalScoresOut = {
  review_id: fixtureReviewCompleted.id,
  total_comments: 8,
  rated_comments: 6,
  // 5/6. Above §8.1's 70%, and deliberately not a round number: rounding
  // happens once at render, and "83%" is what should reach the screen.
  approval_rate: 0.8333333333333334,
  false_positive_rate: 0.16666666666666663,
};

/** Below §8.1's target — 2 of 6, so 33%. */
export const fixtureEvalBelowTarget: EvalScoresOut = {
  review_id: fixtureReviewCompleted.id,
  total_comments: 8,
  rated_comments: 6,
  approval_rate: 0.3333333333333333,
  false_positive_rate: 0.6666666666666667,
};

/**
 * Nobody has rated. `null`, **not** `0.0` — the distinction #191 returns null
 * to preserve, and the state most reviews are actually in.
 */
export const fixtureEvalUnrated: EvalScoresOut = {
  review_id: fixtureReviewCompleted.id,
  total_comments: 8,
  rated_comments: 0,
  approval_rate: null,
  false_positive_rate: null,
};

/**
 * An `approve` verdict: nothing was flagged, so there is nothing to rate and
 * never will be. Distinct from unrated, which is an invitation.
 */
export const fixtureEvalNoComments: EvalScoresOut = {
  review_id: fixtureReviewApproved.id,
  total_comments: 0,
  rated_comments: 0,
  approval_rate: null,
  false_positive_rate: null,
};

/**
 * `GET /analytics/summary`, in the three states worth building for.
 *
 * Written partial-first on purpose. "Everything populated" is the state this
 * account will almost never be in — durations arrive the moment a review
 * finishes, ratings only when somebody clicks — and building it first is how
 * `0%` ends up on screen for a metric nobody has measured.
 */

/** Reviews have run and been rated. Every metric has a value. */
export const fixtureAnalyticsSummary: AnalyticsSummaryOut = {
  reviews_total: 14,
  reviews_completed: 12,
  reviews_failed: 2,

  approval_rate: {
    value: 0.8333333333333334,
    target: 0.7,
    comparison: "gt",
    met: true,
    sample_size: 6,
  },
  false_positive_rate: {
    value: 0.16666666666666663,
    target: 0.2,
    comparison: "lt",
    met: true,
    sample_size: 6,
  },
  time_to_review_ms: {
    value: 72400,
    target: 90000,
    comparison: "lt",
    met: true,
    // Smaller than reviews_completed: total_ms is NULL on manual triggers,
    // re-reviews and anything written before METRIC-2.
    sample_size: 9,
  },
  pipeline_duration_ms_median: 41200,

  category_distribution: {
    logic_error: 5,
    security: 0,
    performance: 0,
    architecture: 0,
    convention: 1,
    improvement: 2,
  },
  severity_calibration: [
    { severity: "critical", comments: 1, prs_with_comment: 1, prs_still_open: 1, still_open_rate: 1.0 },
    { severity: "warning", comments: 5, prs_with_comment: 1, prs_still_open: 1, still_open_rate: 1.0 },
    { severity: "info", comments: 2, prs_with_comment: 1, prs_still_open: 1, still_open_rate: 1.0 },
  ],

  token_efficiency: 0.0333,
  token_efficiency_series: [
    {
      review_id: fixtureReviewCompleted.id,
      created_at: "2026-07-28T09:12:44Z",
      value: 0.0333,
    },
  ],

  flagged_reviews: [],
  flagged_reviews_total: 0,
};

/**
 * **The state this page will spend most of its life in.** Reviews have run,
 * so durations and the category spread are real; nobody has rated anything,
 * so every approval-derived figure is `null` — unknown, not zero, and not a
 * missed target.
 */
export const fixtureAnalyticsPartial: AnalyticsSummaryOut = {
  ...fixtureAnalyticsSummary,
  approval_rate: {
    ...fixtureAnalyticsSummary.approval_rate,
    value: null,
    met: null,
    sample_size: 0,
  },
  false_positive_rate: {
    ...fixtureAnalyticsSummary.false_positive_rate,
    value: null,
    met: null,
    sample_size: 0,
  },
  token_efficiency: null,
  token_efficiency_series: [],
};

/**
 * A brand-new account. The API answers 200 with zeros and nulls rather than
 * a 404, so this renders as "nothing yet" and never as an error.
 */
export const fixtureAnalyticsEmpty: AnalyticsSummaryOut = {
  ...fixtureAnalyticsPartial,
  reviews_total: 0,
  reviews_completed: 0,
  reviews_failed: 0,
  time_to_review_ms: {
    ...fixtureAnalyticsSummary.time_to_review_ms,
    value: null,
    met: null,
    sample_size: 0,
  },
  pipeline_duration_ms_median: null,
  category_distribution: {
    logic_error: 0,
    security: 0,
    performance: 0,
    architecture: 0,
    convention: 0,
    improvement: 0,
  },
  severity_calibration: [
    { severity: "critical", comments: 0, prs_with_comment: 0, prs_still_open: 0, still_open_rate: null },
    { severity: "warning", comments: 0, prs_with_comment: 0, prs_still_open: 0, still_open_rate: null },
    { severity: "info", comments: 0, prs_with_comment: 0, prs_still_open: 0, still_open_rate: null },
  ],
};

/**
 * The pair a refresh hands back. Distinct token values from any "current"
 * pair a test seeds, so an assertion can tell the two apart and prove the
 * retry actually used the *new* access token.
 */
export const fixtureTokenPair: TokenPair = {
  access_token: "refreshed-access-token",
  refresh_token: "refreshed-refresh-token",
  token_type: "bearer",
  expires_in: 900,
};
