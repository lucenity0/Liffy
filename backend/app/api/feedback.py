"""Comment feedback (report §3 step 14, §6.4).

The write half of the evaluation loop: a rating stored here is what
``eval_service`` later turns into report §8.1's approval rate. Until EVAL-1
both routes were stubs returning fixed values — the POST answered
``{"status": "saved"}`` without touching the database, which is worse than
answering nothing because it looks like it worked.
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, owned_comment_or_404
from app.database import get_db
from app.models.comment_feedback import CommentFeedback
from app.models.user import User
from app.schemas.feedback import FeedbackIn, FeedbackOut

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


@router.get("/reviews/{review_id}/eval")
def review_eval(
    review_id: str,
    user: User = Depends(get_current_user),
) -> dict[str, str | float]:
    # Still a stub: hardcoded zeros that a reader would take for measurements.
    # EVAL-2 (#191) replaces it with real numbers computed off the rows the
    # route above now writes. Left alone here deliberately — this issue's job
    # is to give that computation something to read.
    return {"review_id": review_id, "approval_rate": 0.0, "false_positive_rate": 0.0}
