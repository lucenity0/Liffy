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

    # Both null on every comment written before this milestone, which today is
    # the majority of the table. Null is "not asked or not answered", not a
    # third value, and the dashboard has to render it as nothing rather than as
    # an empty container.
    confidence: str | None = None
    failure_scenario: str | None = None

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


class LatestFindingOut(BaseModel):
    """One finding, with just enough context to say where it came from.

    The dashboard's proof-of-work: a stat strip says a job ran, a real
    line-anchored comment says the product works. Deliberately *not* a whole
    review — ``ReviewDetailOut`` carries ``raw_diff``, and downloading a
    40-file patch to render three lines of prose is the reason this exists as
    its own endpoint rather than a second call to the detail route.

    ``None`` from the endpoint rather than a 404: an account with no findings
    yet is the ordinary first-run state, not an error, and the band simply
    does not render.
    """

    model_config = ConfigDict(from_attributes=True)

    review_id: uuid.UUID
    pr_number: int
    repo_full_name: str
    reviewed_at: datetime
    comment: ReviewCommentOut


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
    # Only ever set on a failed review. `failure_detail` is the raw provider
    # output, uncapped, for the disclosure the UI puts behind the message;
    # `failure_kind` is whether the reader can act — `unknown` means offer a
    # bug report rather than advice. Null on every successful review and on
    # every row written before these existed.
    failure_detail: str | None = None
    failure_kind: str | None = None
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
    # So the detail page can render the per-pull-request auto-review toggle
    # without a second request for the pull request it already names.
    # The pull request's own id is already here as `ReviewOut.pr_id`, which is
    # the foreign key into `pull_requests` — so the toggle has what it needs to
    # address the PATCH without a second field carrying the same value.
    auto_review: bool = False
    comments: list[ReviewCommentOut]
    # Detail only — never on ReviewListItem. Diffs are large and the list stays light.
    raw_diff: str | None = None
