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
export type IndexStatus = "indexed" | "not_indexed";

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
