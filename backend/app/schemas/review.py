import uuid
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict


class ReviewVerdict(str, Enum):
    approve = "approve"
    request_changes = "request_changes"
    comment = "comment"


class ReviewCategory(str, Enum):
    logic_error = "logic_error"
    security = "security"
    performance = "performance"
    architecture = "architecture"
    convention = "convention"
    improvement = "improvement"


class ReviewSeverity(str, Enum):
    critical = "critical"
    warning = "warning"
    info = "info"


class LLMReviewComment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file: str
    line_start: int
    line_end: int
    category: ReviewCategory
    severity: ReviewSeverity
    comment: str
    suggestion: str | None = None


class LLMReviewOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str
    verdict: ReviewVerdict
    comments: list[LLMReviewComment]


# ── API response models (BASE-10) ────────────────────────────────────────────


class ReviewCommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    file_path: str
    line_start: int
    line_end: int
    category: str
    severity: str
    comment_text: str
    suggestion: str | None
    created_at: datetime


class ReviewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    pr_id: uuid.UUID
    status: str
    summary: str | None
    verdict: str | None
    model_used: str | None
    tokens_used: int | None
    # Report §8.1. Null on rows written before the instrumentation landed, and
    # on any review still in flight — so every consumer has to tolerate None
    # rather than assume a number.
    duration_ms: int | None
    # Report §8.1's time-to-review: webhook receipt -> complete, the figure the
    # < 90s target is about. Also null on manual triggers and re-reviews, which
    # have no receipt — and it deliberately does not fall back to duration_ms.
    #
    # Queue wait is `total_ms - duration_ms`. Both operands are nullable and
    # measured by different clocks in different processes, so the subtraction
    # is left to the caller rather than shipped as a third field.
    total_ms: int | None
    created_at: datetime
    queued_at: datetime | None
    completed_at: datetime | None


class ReviewListItem(ReviewOut):
    pr_number: int
    repo_full_name: str


class ReviewDetailOut(ReviewOut):
    # Same join the list does. Without these a review fetched by id cannot say
    # which PR it belongs to, and the detail page is most often reached by a
    # deep link rather than from the list — there is nothing to fall back on.
    pr_number: int
    repo_full_name: str
    comments: list[ReviewCommentOut]
    # Detail only — never on ReviewListItem. Diffs are large and the list stays light.
    raw_diff: str | None = None
