from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class FeedbackInput(BaseModel):
    rating: int


@router.post("/comments/{comment_id}/feedback")
def submit_feedback(comment_id: str, payload: FeedbackInput) -> dict[str, int | str]:
    if payload.rating not in {1, -1}:
        return {"comment_id": comment_id, "status": "invalid", "rating": payload.rating}
    return {"comment_id": comment_id, "status": "saved", "rating": payload.rating}


@router.get("/reviews/{review_id}/eval")
def review_eval(review_id: str) -> dict[str, str | float]:
    return {"review_id": review_id, "approval_rate": 0.0, "false_positive_rate": 0.0}
