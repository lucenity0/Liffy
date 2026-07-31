"""Comment feedback (report §3 step 14, §6.4).

The write half of the evaluation loop: a rating stored here is what
``eval_service`` later turns into report §8.1's approval rate. Until EVAL-1
both routes were stubs returning fixed values — the POST answered
``{"status": "saved"}`` without touching the database, which is worse than
answering nothing because it looks like it worked.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, owned_comment_or_404, owned_review_or_404
from app.database import get_db
from app.models.comment_feedback import CommentFeedback
from app.models.user import User
from app.schemas.feedback import EvalScoresOut, FeedbackIn, FeedbackOut
from app.services.eval_service import ReviewScores, compute_review_scores

router = APIRouter()


@router.post("/comments/{comment_id}/feedback", response_model=FeedbackOut)
def submit_feedback(
    comment_id: uuid.UUID,
    payload: FeedbackIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CommentFeedback:
    """Rate a comment thumbs up (``1``) or thumbs down (``-1``).

    Idempotent per (comment, user): re-rating **replaces** the previous value
    rather than appending a second row, so a user who changes their mind ends
    with exactly one row. The unique constraint on the table backs that up, but
    the select-then-update below is what implements it — catching an
    ``IntegrityError`` would work too, read worse, and buy nothing: at this
    scale there is no concurrent-click race to lose.

    An invalid rating never reaches here. ``FeedbackIn.rating`` is
    ``Literal[1, -1]``, so FastAPI answers 422 before the handler runs.

    A rating for a comment on somebody else's review is a 404, not a 403 — see
    ``owned_comment_or_404``.
    """
    owned_comment_or_404(db, comment_id, user)

    existing = db.scalar(
        select(CommentFeedback).where(
            CommentFeedback.comment_id == comment_id,
            CommentFeedback.user_id == user.id,
        )
    )
    if existing is None:
        existing = CommentFeedback(comment_id=comment_id, user_id=user.id, rating=payload.rating)
        db.add(existing)
    else:
        existing.rating = payload.rating
    db.commit()
    db.refresh(existing)
    return existing


@router.get("/reviews/{review_id}/eval", response_model=EvalScoresOut)
def review_eval(
    review_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ReviewScores:
    """Report §8.1's approval and false-positive rate for one review.

    Computed **live** from ``comment_feedback`` on every request. It
    deliberately does not read ``eval_scores`` — that table is the weekly
    snapshot the beat job writes (#192), and this endpoint has to reflect a
    thumbs-up from ten seconds ago.

    Another user's review is a 404, same as everywhere else.
    """
    owned_review_or_404(db, review_id, user)

    scores = compute_review_scores(db, review_id)
    # Unreachable: the ownership walk above already proved the row exists, and
    # nothing deletes it in between. Kept because `compute_review_scores` is
    # typed as returning None and silently ignoring that would mean a 500 with
    # an AttributeError if the two ever drift apart.
    if scores is None:
        raise HTTPException(status_code=404, detail="Review not found")
    return scores
