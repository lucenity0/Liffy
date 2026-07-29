import type {
  RepoOut,
  RepoStatusOut,
  ReviewCommentOut,
  ReviewDetailOut,
  ReviewListItem,
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
};

export const fixtureRepoStatusNotIndexed: RepoStatusOut = {
  id: fixtureRepoIndexing.id,
  full_name: fixtureRepoIndexing.full_name,
  status: "not_indexed",
  indexed_at: null,
  chunk_count: 0,
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
  created_at: "2026-07-25T14:30:00Z",
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
  created_at: "2026-07-24T09:00:00Z",
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
  created_at: "2026-07-26T08:00:00Z",
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
  created_at: "2026-07-23T11:00:00Z",
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
  created_at: review.created_at,
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
