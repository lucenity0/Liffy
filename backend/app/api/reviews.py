from fastapi import APIRouter

from app.schemas.review import LLMReviewOutput

router = APIRouter()


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
