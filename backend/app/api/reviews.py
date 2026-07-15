import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.schemas.review import ReviewCommentOut, ReviewDetailOut, ReviewListItem, ReviewOut
from app.services.review_service import get_review_with_comments
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


@router.get("/reviews", response_model=list[ReviewListItem])
def list_reviews(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
) -> list[ReviewListItem]:
    rows = db.execute(
        select(Review, PullRequest.github_pr_number, Repository.full_name)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .order_by(Review.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return [
        ReviewListItem(
            **ReviewOut.model_validate(review).model_dump(),
            pr_number=pr_number,
            repo_full_name=full_name,
        )
        for review, pr_number, full_name in rows
    ]


def _detail(db: Session, review_id: uuid.UUID) -> ReviewDetailOut:
    fetched = get_review_with_comments(db, review_id)
    if fetched is None:
        raise HTTPException(status_code=404, detail="Review not found")
    review, comments = fetched
    return ReviewDetailOut(
        **ReviewOut.model_validate(review).model_dump(),
        comments=[ReviewCommentOut.model_validate(c) for c in comments],
    )


@router.get("/reviews/{review_id}", response_model=ReviewDetailOut)
def get_review(review_id: uuid.UUID, db: Session = Depends(get_db)) -> ReviewDetailOut:
    return _detail(db, review_id)


@router.get("/prs/{pr_id}/review", response_model=ReviewDetailOut)
def get_pr_review(pr_id: uuid.UUID, db: Session = Depends(get_db)) -> ReviewDetailOut:
    latest_id = db.scalar(
        select(Review.id)
        .where(Review.pr_id == pr_id)
        .order_by(Review.created_at.desc())
        .limit(1)
    )
    if latest_id is None:
        raise HTTPException(status_code=404, detail="No review for this pull request")
    return _detail(db, latest_id)


@router.post("/reviews/{review_id}/trigger", status_code=202)
def trigger_rereview(review_id: uuid.UUID, db: Session = Depends(get_db)) -> dict[str, str | int]:
    """Re-run the pipeline for the PR behind an existing review."""
    review = db.get(Review, review_id)
    if review is None:
        raise HTTPException(status_code=404, detail="Review not found")
    pr = db.get(PullRequest, review.pr_id)
    repo = db.get(Repository, pr.repo_id)
    owner, name = repo.full_name.split("/", 1)
    review_worker.enqueue_review(owner, name, pr.github_pr_number)
    return {"status": "queued", "repo": repo.full_name, "pr_number": pr.github_pr_number}
