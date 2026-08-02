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


class LLMFileNote(BaseModel):
    """One changed file, and what the change does to it."""

    model_config = ConfigDict(extra="forbid")

    path: str
    description: str


class LLMReviewOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str
    """Prose. Two or three sentences, and the *only* part shown in the list.

    Kept plain deliberately: it is the one-liner on the reviews page, so a
    heading or a bullet here would put markdown syntax in a table cell.
    """

    verdict: ReviewVerdict
    comments: list[LLMReviewComment]

    # Both default to empty, and that is load-bearing rather than lazy. A model
    # that answers with the older three-field shape still validates, so the
    # retry loop is not spent arguing about presentation — and a review whose
    # findings are right but whose file table is missing is still a good
    # review. Presentation degrades; the review does not fail.
    changes: list[str] = []
    """What the pull request *does*, one bullet per change."""

    files: list[LLMFileNote] = []
    """Per-file notes, rendered as a table on the pull request."""


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
    # The *caller's own* rating: 1, -1, or None when they have not rated it.
    # Scoped to the authenticated user — another user's rating never appears
    # here, which is what stops a shared review leaking who thought what.
    #
    # Without it a rating vanishes on reload: the button reverts to un-clicked
    # and the user rates the same comment again, quietly double-counting their
    # own opinion in the approval rate.
    #
    # Detail responses only. It defaults to None rather than being required so
    # that anything constructing a ReviewCommentOut straight from an ORM row —
    # which carries no notion of a caller — still validates.
    my_rating: int | None = None


class ReviewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    pr_id: uuid.UUID
    status: str
    summary: str | None
    # The structured half of the overview, or None when the model produced only
    # prose. Shape: `{"changes": [str], "files": [{"path", "description"}]}`.
    # Deliberately loose — this is presentation, and pinning it in a response
    # model would mean a migration every time the overview grows a section.
    summary_detail: dict | None
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
