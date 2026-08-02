/**
 * Mirrors of the backend's Pydantic schemas. Keep in lockstep with
 * `backend/app/schemas/review.py`, `backend/app/schemas/repo.py` and
 * `backend/app/schemas/auth.py`.
 *
 * Note the backend types `status`, `verdict`, `category` and `severity` as
 * plain `str`, not enums — the LLM populates them. The unions below are what
 * we *expect*; anything rendering them must tolerate an unknown value rather
 * than assume exhaustiveness at runtime.
 */

export type ReviewStatus = "pending" | "processing" | "completed" | "failed";
export type Verdict = "approve" | "request_changes" | "comment";
export type Category =
  | "logic_error"
  | "security"
  | "performance"
  | "architecture"
  | "convention"
  | "improvement";
export type Severity = "critical" | "warning" | "info";
export type IndexStatus = "indexed" | "indexing" | "not_indexed";

export interface RepoOut {
  id: string;
  full_name: string;
  default_branch: string;
  indexed_at: string | null;
  created_at: string;
}

export interface RepoStatusOut {
  id: string;
  full_name: string;
  status: IndexStatus;
  indexed_at: string | null;
  chunk_count: number;
  /**
   * Files the **last** index run skipped because fetching or chunking raised.
   * Non-zero means the index is *partial*: those files have no chunks, so
   * reviews touching them retrieve no context.
   *
   * `null` on repositories indexed before this was recorded — "never
   * measured", which is not the same as "measured, nothing failed". Only the
   * latter (`0`) earns a clean chip. Added by #210.
   */
  last_index_failed_files: number | null;
  /** The denominator: "40 skipped" reads differently out of 45 than out of 4,000. */
  last_indexed_files_seen: number | null;
}

export interface ReviewOut {
  id: string;
  pr_id: string;
  status: ReviewStatus;
  summary: string | null;
  verdict: Verdict | null;
  model_used: string | null;
  tokens_used: number | null;
  /**
   * Wall-clock milliseconds for the review pipeline.
   *
   * A *lower bound* on report §8.1's time-to-review, not that figure: §8.1
   * counts from webhook receipt, and the queue wait before the worker picks
   * the job up is not included here. `total_ms` is that figure — present this
   * one as "time to review" against the < 90s target and it will read low.
   *
   * Null on reviews still in flight, and on any row written before the
   * instrumentation landed.
   */
  duration_ms: number | null;
  /**
   * Report §8.1's time-to-review: webhook receipt -> review complete, against
   * the < 90s target. This is the figure; `duration_ms` is a lower bound on it.
   *
   * Null on manual triggers and re-reviews — those have no webhook receipt,
   * and it deliberately does *not* fall back to `duration_ms`, which would
   * report a pipeline duration as an end-to-end one. Also null on legacy rows
   * and on reviews still in flight.
   *
   * Queue wait is `total_ms - duration_ms` — the number that says whether a
   * missed target is Liffy's pipeline or the broker's backlog. The two are
   * measured by different clocks in different processes, so treat a small
   * negative as skew rather than as data.
   */
  total_ms: number | null;
  created_at: string;
  /**
   * When the webhook delivery arrived, stamped in the API process. Null on
   * manual triggers, re-reviews, and legacy rows.
   */
  queued_at: string | null;
  completed_at: string | null;
}

export interface ReviewListItem extends ReviewOut {
  pr_number: number;
  repo_full_name: string;
}

export interface ReviewCommentOut {
  id: string;
  file_path: string;
  line_start: number;
  line_end: number;
  category: Category;
  severity: Severity;
  comment_text: string;
  suggestion: string | null;
  created_at: string;
  /**
   * The *caller's own* rating for this comment — `1`, `-1`, or `null` when
   * they haven't rated it. Another user's rating never appears here.
   *
   * This is what makes a rating survive a page reload; without it the button
   * reverts to un-clicked and the same comment gets rated twice.
   *
   * `number | null` rather than `1 | -1 | null` for the same reason `category`
   * and `severity` are loose above: the column has no DB check constraint, so
   * render defensively. Added by #190.
   *
   * Detail responses only — `ReviewListItem` carries no comments at all.
   */
  my_rating: number | null;
}

/**
 * `POST /comments/{comment_id}/feedback`. Re-rating replaces rather than
 * appending, and `created_at` stays at the row's original creation time —
 * there is no `updated_at` on `comment_feedback` by design (report §5).
 */
export interface FeedbackOut {
  comment_id: string;
  rating: number;
  created_at: string;
}

/**
 * `GET /reviews/{review_id}/eval`. Real as of #191 — the stub that returned
 * hardcoded `0.0` for both rates is gone.
 *
 * Computed live from `comment_feedback` on every request. It deliberately does
 * *not* read the `eval_scores` table, which is #192's weekly snapshot, so a
 * thumbs-up from ten seconds ago is already in these numbers.
 */
export interface EvalScoresOut {
  review_id: string;
  /** Every comment on the review, rated or not. */
  total_comments: number;
  /**
   * The denominator, and the reason it is in the response at all: a good
   * review with one rating scores 100%, not 12.5%. A bare percentage over a
   * sample of six invites a conclusion the data cannot support, so anything
   * rendering the rate has to render this next to it.
   */
  rated_comments: number;
  /**
   * `null` means **nobody has rated yet**. `0` means every rating was
   * negative. Those are different facts and the backend went out of its way
   * to keep them apart — `approval_rate ?? 0` puts back exactly the bug #191
   * existed to remove, and tells a user their review was rejected when in
   * truth it was never read. Branch on `=== null`.
   *
   * Unrounded. Round once, at render.
   */
  approval_rate: number | null;
  /**
   * Arithmetic on `approval_rate`, not a second signal. `comment_feedback`
   * has nowhere to record *why* a thumbs-down was given, so this is exactly
   * `1 - approval_rate` — see `docs/decisions/004-approval-vs-false-positive.md`.
   *
   * Present because the column exists and #194 aggregates it. Rendering it
   * beside the approval rate would put a contradiction on screen: §8.1 wants
   * >70% approval *and* <20% false positives, which no single set of ratings
   * can satisfy.
   */
  false_positive_rate: number | null;
}

/**
 * One report §8.1 metric with everything needed to render it — no arithmetic
 * at the call site, and no threshold typed into the frontend.
 *
 * A flat `approval_rate` + `approval_rate_target` pair would not carry the
 * third state: `met` is `null` exactly when `value` is, and a `null` rate is
 * **not** a miss. Anything that renders this has three branches, not two.
 */
export interface Metric {
  value: number | null;
  target: number;
  /** Met when `value > target` / `value < target`. Never hardcode either. */
  comparison: "gt" | "lt";
  /** `null` exactly when `value` is null. Unknown, not failed. */
  met: boolean | null;
  /** What the value was computed over. Show it — n is tiny on this project. */
  sample_size: number;
}

/**
 * `still_open_rate`, not "blocked merge rate". GitHub's REST `state` is
 * `open` or `closed` and does not distinguish merged from closed-without-
 * merging, so what this measures is "PRs carrying such a comment that are not
 * yet resolved". The words "blocked merge" must not reach the screen.
 */
export interface SeverityCalibrationRow {
  severity: string;
  /** Comments Liffy emitted at this severity. */
  comments: number;
  /** PRs carrying at least one such comment — the sample size for the rate. */
  prs_with_comment: number;
  prs_still_open: number;
  /** `null` when `prs_with_comment` is 0. */
  still_open_rate: number | null;
}

/**
 * Read from `eval_scores`, the snapshot #192's weekly job writes — unlike
 * everything else in the summary, which is computed live. So this list is
 * empty until that job has run once, and can lag a rating by up to a week.
 */
export interface FlaggedReview {
  review_id: string;
  pr_number: number;
  repo_full_name: string;
  approval_rate: number;
}

/** Approval rate per 1,000 tokens, for one review. Oldest → newest. */
export interface TokenEfficiencyPoint {
  review_id: string;
  created_at: string;
  value: number;
}

/**
 * `GET /analytics/summary` — every §8.1 metric in one request, scoped to the
 * caller's repositories.
 *
 * Always a 200 for an authenticated caller, including a brand-new account
 * with no repositories: zeros for the counts, `null` for every rate. There is
 * no 404 and no empty-account error, so the page's job is per-tile unknown
 * handling rather than a whole-page empty state.
 */
export interface AnalyticsSummaryOut {
  reviews_total: number;
  reviews_completed: number;
  reviews_failed: number;

  approval_rate: Metric;
  /**
   * Exactly `1 - approval_rate` — see `EvalScoresOut.false_positive_rate` and
   * ADR 004. Carries a target and a `met` because the column and the spec
   * both exist, but it is one number with the other, not a second signal.
   */
  false_positive_rate: Metric;
  /**
   * Median `reviews.total_ms`: webhook receipt → review complete, which is
   * report §1's real < 90s figure. Landed with #197 (PR #204).
   *
   * `total_ms` is NULL on manual triggers, re-reviews and legacy rows, so
   * `sample_size` is smaller than `reviews_completed` — often much smaller.
   * Median rather than mean: one 20-minute retry skews a mean past use.
   */
  time_to_review_ms: Metric;
  /**
   * Median `reviews.duration_ms` — the `run_review` internals only, with no
   * queue wait in it. A lower bound on time-to-review, carrying no target,
   * present so the queue wait can be read as the difference between the two.
   */
  pipeline_duration_ms_median: number | null;

  /**
   * All six `ReviewCategory` keys, zeros included — #193 fills the gaps
   * against the enum rather than trusting `GROUP BY`, which drops categories
   * that never fired. A seventh key, `"other"`, appears **only when non-zero**
   * and buckets any value outside the enum. Iterate the six and append
   * `other` if present; do not assume exactly six, and do not hide a non-zero
   * `other`.
   */
  category_distribution: Record<string, number>;
  /** All three severities, critical → warning → info, even at zero. */
  severity_calibration: SeverityCalibrationRow[];

  /**
   * Mean approval rate per 1,000 tokens. Reviews with no token count are
   * excluded from the denominator rather than counted as zero; `null` when no
   * review has both a token count and any feedback.
   */
  token_efficiency: number | null;
  /** Last 30 qualifying reviews, oldest → newest. Usually far fewer. */
  token_efficiency_series: TokenEfficiencyPoint[];

  /** Capped at 20. Compare against the total before claiming it is all of them. */
  flagged_reviews: FlaggedReview[];
  flagged_reviews_total: number;
}

export interface ReviewDetailOut extends ReviewOut {
  /**
   * The same join the list does. Without these a review fetched by id cannot
   * say which PR it belongs to, and the detail page is most often reached by
   * a deep link rather than from the list. Added by #136.
   */
  pr_number: number;
  repo_full_name: string;
  comments: ReviewCommentOut[];
  /** Detail only — never present on ReviewListItem. Added by #127. */
  raw_diff: string | null;
}

/** 202 from POST /reviews/trigger. Deliberately carries no review id. */
export interface TriggerAccepted {
  status: string;
  repo: string;
  pr_number: number;
}

export interface IndexAccepted {
  repo_id: string;
  status: string;
}

// ── Auth (backend/app/schemas/auth.py) ───────────────────────────────────────

/**
 * Returned by `POST /auth/refresh`, and carried in the OAuth callback
 * fragment. `refresh_token` is always a *new* value: the backend rotates and
 * revokes on use, so the pair this replaces is dead the moment it arrives.
 */
export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  /** Access-token lifetime in seconds — 900 (15 minutes) by default. */
  expires_in: number;
}

/** `GET /auth/me`. `email` and `avatar_url` are nullable on GitHub's side. */
export interface UserOut {
  id: string;
  github_id: number;
  username: string;
  email: string | null;
  avatar_url: string | null;
}

// ── Settings (backend/app/schemas/setting.py) ────────────────────────────────

/** Where a value came from. The reason the page explains rather than just edits. */
export type SettingSource = "default" | "env" | "override";

export interface EditableSetting {
  key: string;
  group: string;
  label: string;
  help: string;
  kind: "str" | "bool" | "int" | "choice";
  choices: string[];
  /** Offered as a dropdown, but the field stays open — unlike `choices`. */
  suggestions: string[];
  /** `llm_provider` values this setting matters for; empty means always. */
  applies_to: string[];
  minimum: number | null;
  maximum: number | null;
  value: string | number | boolean;
  default_value: string | number | boolean;
  source: SettingSource;
  /** Reaches outside Liffy when enabled, so the UI confirms first. */
  confirm_on_enable: boolean;
}

export interface ReadOnlySetting {
  key: string;
  group: string;
  label: string;
  /** Why it cannot be changed here. Rendered beside the disabled control. */
  reason: string;
  value: string | number | boolean;
}

/**
 * A secret's existence and nothing else. There is deliberately no `value`
 * field to render — not even a masked one, which would still leak the length.
 */
export interface SecretSetting {
  key: string;
  label: string;
  /** What an unset value means for this one — needed, or genuinely optional. */
  requirement: string;
  /** `llm_provider` values this credential matters for; empty means always. */
  applies_to: string[];
  /** True when the page may set this one, rather than only report on it. */
  connectable: boolean;
  /** The command that produces the value, shown in the connect dialog. */
  connect_command: string;
  is_set: boolean;
  /**
   * Where the value came from. `is_set` cannot answer "can I disconnect this?"
   * — a `.env` token and a connected one both read as set — so only `override`
   * gets a Disconnect button; the rest get Replace.
   */
  source: SettingSource;
}

export interface SettingsOut {
  editable: EditableSetting[];
  read_only: ReadOnlySetting[];
  secrets: SecretSetting[];
}

// ── Help (backend/app/schemas/help.py) ───────────────────────────────────────

export interface HelpLink {
  slug: string;
  title: string;
}

export interface HelpPassage {
  slug: string;
  title: string;
  /** The opening of the page — what the list pane shows. */
  snippet: string;
  /** The whole page, as markdown. The reading pane renders all of it. */
  body: string;
  related: HelpLink[];
  /**
   * Names a diagram the client draws above the text, or "" for none. A *name*,
   * never markup — the corpus says which illustration belongs to a page and
   * `Figure` owns the drawing, so a document can never inject markup.
   */
  figure: string;
  score: number;
}

export interface HelpSearchOut {
  query: string;
  /**
   * Empty means *nothing matched*, which is an answer rather than an error.
   * Render it as "Liffy's docs don't cover that" — never as a failure, and
   * never by falling back to the closest miss.
   */
  results: HelpPassage[];
}

export interface HelpTopic {
  slug: string;
  title: string;
}

export interface HelpIndexOut {
  common: HelpTopic[];
  all_topics: HelpTopic[];
}
