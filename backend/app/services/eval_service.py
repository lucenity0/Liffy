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

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models.comment_feedback import CommentFeedback
from app.models.review import Review
from app.models.review_comment import ReviewComment


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
