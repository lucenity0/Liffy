"""Aggregate quality metrics (report §8.1).

Not in report §6, which lists only the two feedback routes. The addition is
deliberate: the alternative is the analytics page issuing one request per
review to build an average, which is an N+1 across the network. See
``docs/api.md``.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.database import get_db
from app.models.user import User
from app.schemas.analytics import AnalyticsSummaryOut
from app.services.eval_service import AnalyticsSummary, summarize

router = APIRouter()


@router.get("/summary", response_model=AnalyticsSummaryOut)
def analytics_summary(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> AnalyticsSummary:
    """Every §8.1 metric for the caller's repositories, with its target.

    Authenticated because this exposes aggregate data about private
    repositories — and scoped to ``user.id`` all the way down, which is the
    single most important property of this endpoint.

    An account with no repositories returns ``200`` with zeros and nulls. It is
    the state every new user is in, and a 404 or a 500 there would read as the
    page being broken.

    Not cached. At two users and a few dozen reviews that would be premature,
    and a stale dashboard during a demo is worse than a slow one.
    """
    return summarize(db, user_id=user.id)
