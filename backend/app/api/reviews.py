from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.schemas.review import LLMReviewOutput
from app.workers import review_worker

router = APIRouter()


class TriggerReviewRequest(BaseModel):
    owner: str
    repo: str
    pr_number: int = Field(gt=0)


@router.post("/reviews/trigger", status_code=202)
def trigger_review_manual(payload: TriggerReviewRequest) -> dict[str, str | int]:
    """Manual demo path (no auth yet): enqueue a review for any accessible PR."""
    review_worker.enqueue_review(payload.owner, payload.repo, payload.pr_number)
    return {
        "status": "queued",
        "repo": f"{payload.owner}/{payload.repo}",
        "pr_number": payload.pr_number,
    }


@router.get("/reviews")
def list_reviews() -> list[dict[str, str]]:
    return []


@router.get("/reviews/{review_id}")
def get_review(review_id: str) -> dict[str, str]:
    return {"review_id": review_id, "status": "completed"}


@router.get("/prs/{pr_id}/review")
def get_pr_review(pr_id: str) -> dict[str, str]:
    return {"pr_id": pr_id, "status": "completed"}


@router.post("/reviews/{review_id}/trigger")
def trigger_review(review_id: str) -> dict[str, str]:
    return {"review_id": review_id, "status": "queued"}


@router.post("/reviews/validate-output")
def validate_llm_output(payload: LLMReviewOutput) -> dict[str, str]:
    return {"status": "valid", "verdict": payload.verdict.value}
