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

    # One aggregate rather than loading every feedback row into Python.
    #
    # `count(distinct ...)` on the comment id because the outer join fans out:
    # a comment with two ratings would otherwise be counted twice in the total.
    #
    # `coalesce` around the sum because `sum()` over no rows is NULL, not 0 —
    # the unrated case would otherwise arrive here as None and break the
    # arithmetic below rather than the branch that is meant to catch it.
    row = db.execute(
        select(
            func.count(func.distinct(ReviewComment.id)).label("total"),
            func.count(CommentFeedback.id).label("rated"),
            func.coalesce(
                func.sum(case((CommentFeedback.rating == 1, 1), else_=0)), 0
            ).label("positive"),
        )
        .select_from(ReviewComment)
        .outerjoin(CommentFeedback, CommentFeedback.comment_id == ReviewComment.id)
        .where(ReviewComment.review_id == review_id)
    ).one()

    total, rated, positive = int(row.total), int(row.rated), int(row.positive)

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
