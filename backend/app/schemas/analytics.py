"""Response models for ``GET /analytics/summary`` (report §8.1).

Its own module rather than more of ``schemas/feedback.py``: this is six nested
models serving one endpoint, and the feedback schemas are two flat ones serving
two others.

**Report §6 does not specify this endpoint.** It is a deliberate addition, and
the justification is concrete — the alternative is the analytics page issuing
one request per review to build an average, which is an N+1 across the network.
Noted in ``docs/api.md`` alongside the route.
"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


class Metric(BaseModel):
    """A §8.1 metric with its target and whether it is met.

    The target ships in the response so the page renders "are we hitting §8.1"
    without a threshold typed into a component. A frontend that hardcodes
    ``0.70`` is ignoring this contract.

    ``met`` has **three** states, not two: ``true``, ``false``, and ``null``
    when ``value`` is null. A rate nobody has produced yet is *unknown*, not
    missed — collapsing those is how a fresh account renders as a failing one.

    ``sample_size`` is what the value was computed over, and belongs next to it
    wherever it is displayed. On this project n is always small.
    """

    model_config = ConfigDict(from_attributes=True)

    value: float | None
    target: float
    comparison: Literal["gt", "lt"]
    met: bool | None
    sample_size: int


class SeverityCalibrationRow(BaseModel):
    """One severity's row of §8.1's calibration audit.

    ``prs_still_open`` is **not** a blocked-merge count. GitHub's REST ``state``
    is ``open`` or ``closed`` and does not distinguish merged from
    closed-without-merging, so this is a proxy for "not yet resolved". Do not
    label it "blocked merge" on screen — the data cannot support the claim.
    """

    model_config = ConfigDict(from_attributes=True)

    severity: str
    comments: int
    prs_with_comment: int
    prs_still_open: int
    still_open_rate: float | None


class TokenEfficiencyPoint(BaseModel):
    """One review's approval rate per 1,000 tokens."""

    model_config = ConfigDict(from_attributes=True)

    review_id: uuid.UUID
    created_at: datetime
    value: float


class FlaggedReview(BaseModel):
    """A sub-50% review, with enough context to open it."""

    model_config = ConfigDict(from_attributes=True)

    review_id: uuid.UUID
    pr_number: int
    repo_full_name: str
    approval_rate: float


class AnalyticsSummaryOut(BaseModel):
    """Every report §8.1 metric in one response.

    **Every rate is nullable.** A fresh account with no feedback renders an
    empty state, not five zeros pretending to be measurements — the same
    principle ``EvalScoresOut`` preserves for a single review.

    The most common state in practice is neither empty nor full: reviews exist
    but nothing is rated, so ``approval_rate.value`` is null while
    ``category_distribution`` and the durations carry real numbers. That is
    per-metric unknown handling, not a whole-page empty state.
    """

    model_config = ConfigDict(from_attributes=True)

    reviews_total: int
    reviews_completed: int
    reviews_failed: int

    approval_rate: Metric
    false_positive_rate: Metric
    # Report §8.1's time-to-review: webhook receipt -> complete, against §1's
    # < 90s target. Null on manual triggers and re-reviews, which have no
    # receipt, so its ``sample_size`` is smaller than ``reviews_completed``.
    time_to_review_ms: Metric
    # ``run_review`` internals only — a *lower bound* on the figure above, not a
    # second measurement of it. No target attached: presenting it against the
    # 90s line would flatter the system by exactly the queue wait.
    pipeline_duration_ms_median: int | None

    # All six ``ReviewCategory`` keys, zeros included. A seventh, ``other``,
    # appears only when non-zero.
    category_distribution: dict[str, int]
    severity_calibration: list[SeverityCalibrationRow]

    token_efficiency: float | None
    # Oldest first. Usually far shorter than ``reviews_completed`` — a point
    # needs both a token count and a rating — so a chart should say how many
    # reviews it is actually drawing.
    token_efficiency_series: list[TokenEfficiencyPoint]

    # From ``eval_scores``, the weekly snapshot: empty until that job has run,
    # and it can lag a rating by up to a week. Everything else here is live.
    flagged_reviews: list[FlaggedReview]
    flagged_reviews_total: int


class ModelPerformanceRowOut(BaseModel):
    """One model's record over the caller's completed reviews.

    ``useful_rate`` is null rather than 0.0 when nothing has been rated. A
    model nobody has voted on has not scored zero — it has no score, and a
    table that renders the two the same way ranks an unrated model below one
    people actively disliked. ``rated_comments`` travels with the rate so a
    percentage off n=1 is visible as such.
    """

    model_config = ConfigDict(from_attributes=True)

    model: str
    reviews: int
    avg_tokens: int | None
    avg_comments: float
    comments: int
    rated_comments: int
    useful_comments: int
    useful_rate: float | None


class ModelComparisonReviewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    review_id: uuid.UUID
    model: str
    verdict: str | None
    comments: int
    tokens_used: int | None


class ModelComparisonRowOut(BaseModel):
    """One pull request that two or more different models both reviewed."""

    model_config = ConfigDict(from_attributes=True)

    pr_id: uuid.UUID
    repo_full_name: str
    pr_number: int
    reviews: list[ModelComparisonReviewOut]


class ModelAnalyticsOut(BaseModel):
    """The Models tab.

    Separate from ``/analytics/summary`` rather than folded into it: the
    summary is loaded on every visit to Analytics, and these two aggregates
    scan every completed review and every rating to answer a question only
    one of the tabs asks.
    """

    model_config = ConfigDict(from_attributes=True)

    models: list[ModelPerformanceRowOut]
    comparisons: list[ModelComparisonRowOut]


class ActivityOut(BaseModel):
    """``GET /analytics/activity`` — the dashboard's opening figures.

    ``days`` is echoed back rather than assumed by the caller: the window is a
    query parameter, and a strip headed "this week" rendering a 30-day count
    because the two drifted apart is exactly the kind of quiet wrongness a
    dashboard must not have.
    """

    model_config = ConfigDict(from_attributes=True)

    days: int
    reviews: int
    findings: int
    # Repositories with a review in the window, not repositories connected.
    repositories: int
