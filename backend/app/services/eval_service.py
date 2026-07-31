"""Review quality metrics (report §8.1, §8.2).

Report §8 opens with the claim this module has to earn:

    Without measuring review quality there is no feedback loop — and no way to
    improve the system over time. The evaluation layer is what separates Liffy
    from a prompt wrapper.

Deliberately free of FastAPI, following ``auth_service``: every function takes
a ``Session`` and plain values and returns plain values, so the arithmetic is
testable without a running server and the API layer decides what a 404 is.

**On ``None`` versus ``0.0``.** Nothing here reports ``0.0`` to mean "no data".
Zero ratings is not zero approval, and the endpoint this replaced returned a
hardcoded ``0.0`` for an unrated review — which read as a measurement and was
not one. Every rate below is ``float | None``, and the distinction has to
survive all the way to the JSON. See ``docs/decisions/004``.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import case, distinct, func, select
from sqlalchemy.orm import Session

from app.models.comment_feedback import CommentFeedback
from app.models.eval_score import EvalScore
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.review_comment import ReviewComment
from app.schemas.review import ReviewCategory, ReviewSeverity

# Where a comment whose ``category`` is not a known ``ReviewCategory`` is
# counted. Both ``category`` and ``severity`` are plain ``String`` columns
# validated only at the Pydantic boundary (see the docstring on
# ``ReviewComment``), so a row *can* hold something unexpected — from a hand
# edit, a restore, or a future enum value rolled back. Bucketing it beats
# raising: one bad row would otherwise take down the whole metric.
OTHER_CATEGORY = "other"

# Report §8.2: "reviews with approval rate below 50% are flagged for manual
# inspection". Strictly below — a review sitting exactly on 0.5 is not flagged.
#
# One constant, imported. Scattered across the worker, the analytics endpoint
# and the frontend it becomes three thresholds that agree until one of them is
# tuned.
LOW_APPROVAL_THRESHOLD = 0.5


@dataclass(frozen=True)
class ReviewScores:
    """Report §8.1's first two metrics for one review.

    ``false_positive_rate`` is ``1 - approval_rate`` exactly, and is carried
    because report §5 gives ``eval_scores`` both columns — not because it is a
    second signal. ADR 004 records why the spec's two targets conflict and why
    approval is the operative one.
    """

    review_id: uuid.UUID
    total_comments: int
    # Comments carrying a rating from anyone. Equal to the *number of ratings*
    # today: `repositories` has a single `user_id`, so only a repository's
    # owner can reach its comments through the API and no comment can have two
    # raters. The aggregate below counts ratings rather than distinct comments
    # so that stays true if that ever changes — and so a second rater's opinion
    # is not silently dropped.
    rated_comments: int
    approval_rate: float | None
    false_positive_rate: float | None


def _rating_totals(
    db: Session, *, review_id: uuid.UUID | None = None, user_id: uuid.UUID | None = None
) -> tuple[int, int, int]:
    """``(total_comments, ratings, positive_ratings)`` over a scope.

    One aggregate rather than loading every feedback row into Python, and
    **one** aggregate for both scopes rather than two queries that have to stay
    in agreement: ``compute_review_scores`` passes ``review_id``, ``summarize``
    passes ``user_id``. A second approval-rate query written elsewhere is the
    seam being in the wrong place.

    ``count(distinct ...)`` on the comment id because the outer join fans out —
    a comment with two ratings would otherwise be counted twice in the total.

    ``coalesce`` around the sum because ``sum()`` over no rows is NULL, not 0;
    the unrated case would otherwise arrive as ``None`` and break the
    arithmetic rather than reach the branch meant to catch it.
    """
    stmt = select(
        func.count(distinct(ReviewComment.id)),
        func.count(CommentFeedback.id),
        func.coalesce(func.sum(case((CommentFeedback.rating == 1, 1), else_=0)), 0),
    ).select_from(ReviewComment)

    # Ownership joins before the outer join, so the LEFT JOIN stays on the
    # outside and an unrated comment is not filtered out by it.
    if user_id is not None:
        stmt = (
            stmt.join(Review, ReviewComment.review_id == Review.id)
            .join(PullRequest, Review.pr_id == PullRequest.id)
            .join(Repository, PullRequest.repo_id == Repository.id)
            .where(Repository.user_id == user_id)
        )
    stmt = stmt.outerjoin(CommentFeedback, CommentFeedback.comment_id == ReviewComment.id)
    if review_id is not None:
        stmt = stmt.where(ReviewComment.review_id == review_id)

    total, rated, positive = db.execute(stmt).one()
    return int(total), int(rated), int(positive)


def compute_review_scores(db: Session, review_id: uuid.UUID) -> ReviewScores | None:
    """Approval and false-positive rate for one review, live from the ratings.

    ``None`` for a review that does not exist — distinct from a review that
    exists and has no feedback, which is a real result with ``None`` rates.

    A review with **zero comments** is not a failure. An approving review has
    nothing to rate, so it reports ``total_comments = 0`` and ``None`` rates
    rather than raising or dividing by zero.
    """
    exists = db.scalar(select(Review.id).where(Review.id == review_id))
    if exists is None:
        return None

    total, rated, positive = _rating_totals(db, review_id=review_id)

    # Divided in Python, not in SQL. `count(...) / count(...)` is integer
    # division on Postgres and silently returns 0 — an approval rate that is
    # always either 0 or 1, with nothing to indicate it was ever wrong.
    approval = positive / rated if rated else None

    return ReviewScores(
        review_id=review_id,
        total_comments=total,
        rated_comments=rated,
        approval_rate=approval,
        # Complements, per ADR 004. Written as the subtraction rather than as
        # `negative / rated` so the relationship is visible at the call site
        # instead of being an arithmetic coincidence a reader has to derive.
        false_positive_rate=None if approval is None else 1.0 - approval,
    )


# ── Fleet-wide metrics (report §8.1 rows 3, 4 and 5) ──────────────────────────
#
# Everything below is scoped to one user's repositories and needs no feedback
# at all — it reads `review_comments`, which has been populated since BASE-8.
# That independence is why these can be computed on an account where nobody has
# ever clicked a thumb.


def category_distribution(
    db: Session, *, user_id: uuid.UUID, repo_id: uuid.UUID | None = None
) -> dict[str, int]:
    """How the caller's review comments spread across §8.1's six categories.

    **Every category is present, including the ones at zero.** The counts are
    seeded from the ``ReviewCategory`` enum and then filled in from a
    ``GROUP BY`` — never the other way round, because ``GROUP BY`` returns only
    the categories that actually appear. On the first real review three of the
    six never fired, and "0 security comments" is the single most interesting
    number in the table; a query shape that drops it makes the metric useless
    for the thing §8.1 wants it for ("even spread").

    An unrecognised category lands in ``other``, which is present **only when
    non-zero** so the common case stays exactly six keys.
    """
    stmt = (
        select(ReviewComment.category, func.count(ReviewComment.id))
        .select_from(ReviewComment)
        .join(Review, ReviewComment.review_id == Review.id)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(Repository.user_id == user_id)
        .group_by(ReviewComment.category)
    )
    if repo_id is not None:
        stmt = stmt.where(Repository.id == repo_id)

    counts: dict[str, int] = {category.value: 0 for category in ReviewCategory}
    for category, total in db.execute(stmt).all():
        if category in counts:
            counts[category] = int(total)
        else:
            counts[OTHER_CATEGORY] = counts.get(OTHER_CATEGORY, 0) + int(total)
    return counts


@dataclass(frozen=True)
class SeverityCalibrationRow:
    """One severity's share of §8.1's calibration audit.

    ``prs_still_open`` is **not** a blocked-merge count, and the field is named
    for what it measures. Liffy does not track merges: ``pull_requests.status``
    is synced from GitHub's REST ``state``, which is ``open`` or ``closed`` and
    **does not distinguish merged from closed-without-merging**. So "still
    open" is the honest proxy available today — it means "carrying such a
    comment and not yet resolved" — and calling it a merge rate would be a
    claim the data cannot support. Storing ``merged_at`` off the PR payload
    would close the gap properly; that is a follow-up, not this metric.

    ``prs_with_comment`` is the sample size and travels with the rate
    everywhere. §8.1 calls this a *monthly* audit precisely because n is tiny:
    with eight comments on one PR the correlation is meaningless, and a
    percentage quoted off n=1 is worse than no percentage.
    """

    severity: str
    comments: int
    prs_with_comment: int
    prs_still_open: int
    still_open_rate: float | None


def severity_calibration(db: Session, *, user_id: uuid.UUID) -> list[SeverityCalibrationRow]:
    """Do higher-severity comments land on PRs that stay unresolved?

    Counted **per pull request, not per comment**: a PR with four critical
    comments is one data point, not four. Otherwise a single noisy review
    dominates the whole audit.

    Every severity is returned in ``critical`` / ``warning`` / ``info`` order
    even at zero, for the same reason the categories are.
    """
    rows = db.execute(
        select(
            ReviewComment.severity,
            func.count(ReviewComment.id),
            func.count(distinct(PullRequest.id)),
            # COUNT(DISTINCT CASE WHEN ... THEN id END) — the CASE yields NULL
            # for a closed PR and COUNT ignores NULLs, so this is "distinct open
            # PRs" without a second query. Portable across SQLite and Postgres.
            func.count(distinct(case((PullRequest.status == "open", PullRequest.id)))),
        )
        .select_from(ReviewComment)
        .join(Review, ReviewComment.review_id == Review.id)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(Repository.user_id == user_id)
        .group_by(ReviewComment.severity)
    ).all()

    by_severity = {
        severity: (int(comments), int(prs), int(open_prs))
        for severity, comments, prs, open_prs in rows
    }

    out: list[SeverityCalibrationRow] = []
    for severity in ReviewSeverity:
        comments, prs, open_prs = by_severity.get(severity.value, (0, 0, 0))
        out.append(
            SeverityCalibrationRow(
                severity=severity.value,
                comments=comments,
                prs_with_comment=prs,
                prs_still_open=open_prs,
                # Not 0.0 when there is nothing to divide: a severity Liffy has
                # never emitted has no rate, and reporting 0% would read as
                # "every such PR was resolved".
                still_open_rate=(open_prs / prs) if prs else None,
            )
        )
    return out


@dataclass(frozen=True)
class TokenEfficiencyPoint:
    """One review's approval rate per 1,000 tokens, for §8.1's trend."""

    review_id: uuid.UUID
    created_at: datetime
    value: float


def token_efficiency_points(
    db: Session, *, user_id: uuid.UUID
) -> list[TokenEfficiencyPoint]:
    """Per-review token efficiency, oldest first.

    A review qualifies only if it has **both** a token count and at least one
    rating. Rows written before METRIC-1 have ``tokens_used = NULL`` and are
    excluded from the denominator rather than counted as zero — treating an
    unmeasured review as a free one would make efficiency look better the
    further back you look.

    ``tokens_used = 0`` is excluded for the same reason plus a harder one: it
    is a division by zero, and no real review costs nothing.

    Returned as a series rather than only as a mean because §8.1 asks for this
    metric to be "tracked as trend", and a scalar cannot express a trend. #194
    serves both from this one function rather than computing the mean twice.
    """
    rows = db.execute(
        select(
            Review.id,
            Review.created_at,
            Review.tokens_used,
            func.count(CommentFeedback.id),
            func.coalesce(func.sum(case((CommentFeedback.rating == 1, 1), else_=0)), 0),
        )
        .select_from(Review)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .join(ReviewComment, ReviewComment.review_id == Review.id)
        .join(CommentFeedback, CommentFeedback.comment_id == ReviewComment.id)
        .where(
            Repository.user_id == user_id,
            Review.tokens_used.is_not(None),
            Review.tokens_used > 0,
        )
        .group_by(Review.id, Review.created_at, Review.tokens_used)
        .order_by(Review.created_at)
    ).all()

    return [
        TokenEfficiencyPoint(
            review_id=review_id,
            created_at=created_at,
            value=(int(positive) / int(rated)) / (int(tokens) / 1000),
        )
        for review_id, created_at, tokens, rated, positive in rows
        if int(rated) > 0
    ]


def token_efficiency(db: Session, *, user_id: uuid.UUID) -> float | None:
    """Mean approval rate per 1,000 tokens across the caller's reviews.

    ``None`` — not ``0.0`` — when no review has both a token count and any
    feedback, which is the state every account starts in.
    """
    points = token_efficiency_points(db, user_id=user_id)
    if not points:
        return None
    return sum(point.value for point in points) / len(points)


# ── The §8.1 summary (EVAL-5) ─────────────────────────────────────────────────
#
# Targets live here rather than in the frontend so the page renders "is Liffy
# hitting its own targets" without a threshold typed into a component. Report
# §8.1 for the first two; report §1 for the time-to-review one.
APPROVAL_RATE_TARGET = 0.70
FALSE_POSITIVE_RATE_TARGET = 0.20
TIME_TO_REVIEW_TARGET_MS = 90_000.0

# The flagged list is a dashboard panel, not a report. Twenty is enough to act
# on; the true count travels beside it so a truncated list never reads as a
# complete one.
FLAGGED_REVIEW_LIMIT = 20


@dataclass(frozen=True)
class Metric:
    """One §8.1 metric with everything needed to render it.

    ``met`` is ``None`` exactly when ``value`` is — a rate nobody has produced
    yet is *unknown*, not missed, and collapsing those two into a boolean is
    how a fresh account ends up looking like a failing one.

    ``sample_size`` travels with every value for the same reason #193 returns
    it: a percentage without its n invites a conclusion the data cannot
    support, and on this project n is always small.
    """

    value: float | None
    target: float
    comparison: str  # "gt" | "lt"
    met: bool | None
    sample_size: int

    @classmethod
    def build(
        cls, value: float | None, *, target: float, comparison: str, sample_size: int
    ) -> "Metric":
        if value is None:
            met = None
        else:
            met = value > target if comparison == "gt" else value < target
        return cls(
            value=value,
            target=target,
            comparison=comparison,
            met=met,
            sample_size=sample_size,
        )


@dataclass(frozen=True)
class FlaggedReview:
    """A sub-50% review from the persisted snapshot, with enough context to open it."""

    review_id: uuid.UUID
    pr_number: int
    repo_full_name: str
    approval_rate: float


@dataclass(frozen=True)
class AnalyticsSummary:
    reviews_total: int
    reviews_completed: int
    reviews_failed: int
    approval_rate: Metric
    false_positive_rate: Metric
    time_to_review_ms: Metric
    pipeline_duration_ms_median: int | None
    category_distribution: dict[str, int]
    severity_calibration: list[SeverityCalibrationRow]
    token_efficiency: float | None
    token_efficiency_series: list[TokenEfficiencyPoint]
    flagged_reviews: list[FlaggedReview]
    flagged_reviews_total: int


def _median(values: list[int]) -> int | None:
    """Median of a list of milliseconds, or ``None`` when empty.

    In Python rather than ``percentile_cont``: SQLite has no equivalent, and
    adding a Postgres-only query for one number would either split the code
    path or make the tests un-portable. At a few dozen reviews the rows are
    free to fetch.

    Median, not mean — one twenty-minute retry skews a mean past usefulness.
    """
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) // 2


def summarize(db: Session, *, user_id: uuid.UUID) -> AnalyticsSummary:
    """Every §8.1 metric for one user, in one call.

    Composed from what the rest of this module already computes rather than
    re-deriving anything: a second approval-rate query here would mean the two
    could disagree, and the one on the dashboard is the one people would
    believe.

    **Every query is scoped to ``user_id``.** This is the widest-reaching read
    in the codebase — one forgotten join and a user sees aggregate numbers
    across everybody's private repositories.

    An account with no repositories at all is a normal result, not an error:
    zeros for the counts, ``None`` for every rate.
    """
    # Counts by status, scoped. One pass rather than three.
    status_rows = db.execute(
        select(Review.status, func.count(Review.id))
        .select_from(Review)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(Repository.user_id == user_id)
        .group_by(Review.status)
    ).all()
    by_status = {status: int(count) for status, count in status_rows}

    # Approval pooled across **comments**, not averaged across reviews. §8.1
    # says "% of comments", and a mean of per-review rates weights a one-comment
    # review the same as a twenty-comment one — so a single well-received
    # nitpick could outvote a whole rejected review. The next reader will
    # wonder about this; that is why it is written down.
    _, rated, positive = _rating_totals(db, user_id=user_id)
    approval = positive / rated if rated else None

    # Durations, fetched and reduced in Python. NULL rows are excluded rather
    # than treated as 0 — they are unmeasured, not instantaneous.
    duration_rows = db.execute(
        select(Review.duration_ms, Review.total_ms)
        .select_from(Review)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(Repository.user_id == user_id)
    ).all()
    pipeline_ms = [int(d) for d, _ in duration_rows if d is not None]
    total_ms = [int(t) for _, t in duration_rows if t is not None]

    # Flagged reviews come from `eval_scores` — the weekly snapshot #192 writes
    # — because "flagged" is a fact recorded at scoring time. Everything else in
    # this response is live.
    flagged_stmt = (
        select(EvalScore, PullRequest.github_pr_number, Repository.full_name)
        .join(Review, EvalScore.review_id == Review.id)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(Repository.user_id == user_id, EvalScore.flagged.is_(True))
    )
    flagged_total = db.scalar(
        select(func.count()).select_from(flagged_stmt.subquery())
    )
    flagged_rows = db.execute(
        flagged_stmt.order_by(EvalScore.approval_rate).limit(FLAGGED_REVIEW_LIMIT)
    ).all()

    series = token_efficiency_points(db, user_id=user_id)

    return AnalyticsSummary(
        reviews_total=sum(by_status.values()),
        reviews_completed=by_status.get("completed", 0),
        reviews_failed=by_status.get("failed", 0),
        approval_rate=Metric.build(
            approval,
            target=APPROVAL_RATE_TARGET,
            comparison="gt",
            sample_size=rated,
        ),
        false_positive_rate=Metric.build(
            None if approval is None else 1.0 - approval,
            target=FALSE_POSITIVE_RATE_TARGET,
            comparison="lt",
            sample_size=rated,
        ),
        # Report §8.1's real time-to-review, from `total_ms` (webhook receipt ->
        # complete). NULL on manual triggers and re-reviews, which have no
        # receipt, so its sample size is smaller than `reviews_completed` —
        # often much smaller. That is why the n is in the response.
        time_to_review_ms=Metric.build(
            float(_median(total_ms)) if total_ms else None,
            target=TIME_TO_REVIEW_TARGET_MS,
            comparison="lt",
            sample_size=len(total_ms),
        ),
        # `duration_ms` measures inside `run_review` and excludes queue wait, so
        # it is a **lower bound** on the figure above rather than a second
        # measurement of it. No target attached: presenting it against the 90s
        # line would flatter the system by exactly the queue wait.
        pipeline_duration_ms_median=_median(pipeline_ms),
        category_distribution=category_distribution(db, user_id=user_id),
        severity_calibration=severity_calibration(db, user_id=user_id),
        # Both from one call, so the scalar and the series cannot disagree.
        token_efficiency=(
            sum(p.value for p in series) / len(series) if series else None
        ),
        token_efficiency_series=series,
        flagged_reviews=[
            FlaggedReview(
                review_id=score.review_id,
                pr_number=pr_number,
                repo_full_name=full_name,
                approval_rate=score.approval_rate,
            )
            for score, pr_number, full_name in flagged_rows
        ],
        flagged_reviews_total=int(flagged_total or 0),
    )
