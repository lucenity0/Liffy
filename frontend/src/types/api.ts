/**
 * Mirrors of the backend's Pydantic schemas. Keep in lockstep with
 * `backend/app/schemas/review.py` and `backend/app/schemas/repo.py`.
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
}

export interface ReviewOut {
  id: string;
  pr_id: string;
  status: ReviewStatus;
  summary: string | null;
  verdict: Verdict | null;
  model_used: string | null;
  tokens_used: number | null;
  created_at: string;
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
}

export interface ReviewDetailOut extends ReviewOut {
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
