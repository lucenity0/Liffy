import uuid
from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict


# The four strings ``reviews.status`` actually holds, spelled once.
#
# Written at ``review_service.py:208`` (processing), ``:235`` (completed) and
# ``:256`` (failed), with ``pending`` the column default in ``models/review.py``.
# Named here rather than retyped at each filter so a UI label can never quietly
# become a fifth status that matches no row.
ReviewStatus = Literal["pending", "processing", "completed", "failed"]


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


class ReviewListPage(BaseModel):
    """One page of reviews, plus how many there are in total.

    An envelope rather than a bare list because a caller cannot paginate
    honestly without a count: a page that happens to be exactly ``limit`` long
    is indistinguishable from one with more behind it, so the frontend's
    "a full page implies there may be more" heuristic offers a Next that leads
    to an empty page. Filters make that worse, not better — a filtered set
    lands on a page boundary far more often than the unfiltered table does.

    ``total`` counts the *filtered* set, ignoring limit and offset. Not the
    rows on this page, and not the whole table.

    Considered and rejected: returning the count in an ``X-Total-Count``
    header. Less invasive, but it puts half the payload outside the typed
    schema, and the frontend's MSW handlers would then have to remember to set
    a header to stay honest.
    """

    items: list[ReviewListItem]
    total: int


class ReviewDetailOut(ReviewOut):
    # Same join the list does. Without these a review fetched by id cannot say
    # which PR it belongs to, and the detail page is most often reached by a
    # deep link rather than from the list — there is nothing to fall back on.
    pr_number: int
    repo_full_name: str
    comments: list[ReviewCommentOut]
    # Detail only — never on ReviewListItem. Diffs are large and the list stays light.
    raw_diff: str | None = None
