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
  status: "completed",
  summary:
    "One thing worth fixing before this merges: the diff-hunk parser assumes an explicit line count on every hunk header, but the format allows omitting it. Everything else — the setup script, the retry logic — reads cleanly.",
  verdict: "request_changes",
  model_used: "gpt-4o",
  tokens_used: 4213,
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
  status: "completed",
  summary: "Clean change. No issues found.",
  verdict: "approve",
  model_used: "gpt-4o",
  tokens_used: 1802,
  created_at: "2026-07-24T09:00:00Z",
  completed_at: "2026-07-24T09:01:40Z",
  comments: [],
  raw_diff: "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
};

export const fixtureReviewPending: ReviewDetailOut = {
  id: "bbbbbbbb-0000-0000-0000-000000000003",
  pr_id: "cccccccc-0000-0000-0000-000000000003",
  status: "pending",
  summary: null,
  verdict: null,
  model_used: null,
  tokens_used: null,
  created_at: "2026-07-26T08:00:00Z",
  completed_at: null,
  comments: [],
  raw_diff: null,
};

export const fixtureReviewProcessing: ReviewDetailOut = {
  ...fixtureReviewPending,
  id: "bbbbbbbb-0000-0000-0000-000000000004",
  pr_id: "cccccccc-0000-0000-0000-000000000004",
  status: "processing",
};

export const fixtureReviewFailed: ReviewDetailOut = {
  id: "bbbbbbbb-0000-0000-0000-000000000005",
  pr_id: "cccccccc-0000-0000-0000-000000000005",
  status: "failed",
  summary: null,
  verdict: null,
  model_used: "gpt-4o",
  tokens_used: null,
  created_at: "2026-07-23T11:00:00Z",
  completed_at: "2026-07-23T11:00:42Z",
  comments: [],
  raw_diff: null,
};

const detailToListItem = (
  review: ReviewDetailOut,
  overrides: { pr_number: number; repo_full_name: string },
): ReviewListItem => ({
  id: review.id,
  pr_id: review.pr_id,
  status: review.status,
  summary: review.summary,
  verdict: review.verdict,
  model_used: review.model_used,
  tokens_used: review.tokens_used,
  created_at: review.created_at,
  completed_at: review.completed_at,
  ...overrides,
});

export const fixtureReviewListItems: ReviewListItem[] = [
  detailToListItem(fixtureReviewFailed, {
    pr_number: 61,
    repo_full_name: "lucenity0/Liffy",
  }),
  detailToListItem(fixtureReviewProcessing, {
    pr_number: 60,
    repo_full_name: "lucenity0/Liffy",
  }),
  detailToListItem(fixtureReviewApproved, {
    pr_number: 59,
    repo_full_name: "lucenity0/portfolio",
  }),
  detailToListItem(fixtureReviewCompleted, {
    pr_number: 58,
    repo_full_name: "lucenity0/Liffy",
  }),
];

export const fixtureReviewDetailById: Record<string, ReviewDetailOut> = {
  [fixtureReviewCompleted.id]: fixtureReviewCompleted,
  [fixtureReviewApproved.id]: fixtureReviewApproved,
  [fixtureReviewPending.id]: fixtureReviewPending,
  [fixtureReviewProcessing.id]: fixtureReviewProcessing,
  [fixtureReviewFailed.id]: fixtureReviewFailed,
};
