from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import get_current_user
from app.models.user import User

router = APIRouter()

# Both routes are still stubs returning fixed values, but they live in the
# /reviews and /comments namespaces where everything else now requires a
# token. They are protected up front so that whoever wires them to the
# database inherits the check rather than having to remember to add it.


class FeedbackInput(BaseModel):
    rating: int


@router.post("/comments/{comment_id}/feedback")
def submit_feedback(
    comment_id: str,
    payload: FeedbackInput,
    user: User = Depends(get_current_user),
) -> dict[str, int | str]:
    if payload.rating not in {1, -1}:
        return {"comment_id": comment_id, "status": "invalid", "rating": payload.rating}
    return {"comment_id": comment_id, "status": "saved", "rating": payload.rating}


@router.get("/reviews/{review_id}/eval")
def review_eval(
    review_id: str,
    user: User = Depends(get_current_user),
) -> dict[str, str | float]:
    return {"review_id": review_id, "approval_rate": 0.0, "false_positive_rate": 0.0}
