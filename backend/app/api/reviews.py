import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.database import get_db
from app.models.comment_feedback import CommentFeedback
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.user import User
from app.schemas.review import ReviewCommentOut, ReviewDetailOut, ReviewListItem, ReviewOut
from app.services.review_service import get_review_with_comments
from app.workers import review_worker

router = APIRouter()


class TriggerReviewRequest(BaseModel):
    owner: str
    repo: str
    pr_number: int = Field(gt=0)


def _owned_repo_or_404(db: Session, full_name: str, user: User) -> Repository:
    repo = db.scalar(
        select(Repository).where(
            Repository.full_name == full_name, Repository.user_id == user.id
        )
    )
    if repo is None:
        raise HTTPException(status_code=404, detail="Repository not connected")
    return repo


@router.post("/reviews/trigger", status_code=202)
def trigger_review_manual(
    payload: TriggerReviewRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, str | int]:
    """Enqueue a review for a PR on one of the caller's connected repositories.

    Authenticating this route is not enough on its own: it names a repository
    by string rather than by id, so without an ownership check any logged-in
    user could spend tokens reviewing an arbitrary repository.
    """
    full_name = f"{payload.owner}/{payload.repo}"
    _owned_repo_or_404(db, full_name, user)

    review_worker.enqueue_review(payload.owner, payload.repo, payload.pr_number)
    return {
        "status": "queued",
        "repo": full_name,
        "pr_number": payload.pr_number,
    }


@router.get("/reviews", response_model=list[ReviewListItem])
def list_reviews(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ReviewListItem]:
    # The ownership filter rides the join this query already performed rather
    # than costing a second round trip per row.
    rows = db.execute(
        select(Review, PullRequest.github_pr_number, Repository.full_name)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(Repository.user_id == user.id)
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


def _detail(db: Session, review_id: uuid.UUID, user: User) -> ReviewDetailOut:
    # Same join list_reviews does, so a deep-linked review can name its PR —
    # and the ownership filter rides along, making another user's review
    # indistinguishable from one that does not exist.
    identity = db.execute(
        select(PullRequest.github_pr_number, Repository.full_name)
        .join(Review, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(Review.id == review_id, Repository.user_id == user.id)
    ).one_or_none()
    if identity is None:
        raise HTTPException(status_code=404, detail="Review not found")

    fetched = get_review_with_comments(db, review_id)
    if fetched is None:
        raise HTTPException(status_code=404, detail="Review not found")
    review, comments = fetched

    # One statement for every comment's rating, not one per comment: a review
    # with eight comments would otherwise issue nine queries to render a page
    # that already knows all eight ids. Filtered to the caller, so a comment
    # rated -1 by somebody else still reads as unrated here.
    my_ratings: dict[uuid.UUID, int] = {}
    if comments:
        my_ratings = dict(
            db.execute(
                select(CommentFeedback.comment_id, CommentFeedback.rating).where(
                    CommentFeedback.comment_id.in_([c.id for c in comments]),
                    CommentFeedback.user_id == user.id,
                )
            ).all()
        )

    return ReviewDetailOut(
        **ReviewOut.model_validate(review).model_dump(),
        pr_number=identity.github_pr_number,
        repo_full_name=identity.full_name,
        comments=[
            ReviewCommentOut.model_validate(c).model_copy(
                update={"my_rating": my_ratings.get(c.id)}
            )
            for c in comments
        ],
        raw_diff=review.raw_diff,
    )


@router.get("/reviews/{review_id}", response_model=ReviewDetailOut)
def get_review(
    review_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ReviewDetailOut:
    return _detail(db, review_id, user)


@router.get("/prs/{pr_id}/review", response_model=ReviewDetailOut)
def get_pr_review(
    pr_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ReviewDetailOut:
    latest_id = db.scalar(
        select(Review.id)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(Review.pr_id == pr_id, Repository.user_id == user.id)
        .order_by(Review.created_at.desc())
        .limit(1)
    )
    if latest_id is None:
        raise HTTPException(status_code=404, detail="No review for this pull request")
    return _detail(db, latest_id, user)


@router.post("/reviews/{review_id}/trigger", status_code=202)
def trigger_rereview(
    review_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, str | int]:
    """Re-run the pipeline for the PR behind one of the caller's reviews."""
    row = db.execute(
        select(Repository.full_name, PullRequest.github_pr_number)
        .join(PullRequest, PullRequest.repo_id == Repository.id)
        .join(Review, Review.pr_id == PullRequest.id)
        .where(Review.id == review_id, Repository.user_id == user.id)
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Review not found")

    repo_full_name, pr_number = row
    owner, name = repo_full_name.split("/", 1)
    review_worker.enqueue_review(owner, name, pr_number)
    return {"status": "queued", "repo": repo_full_name, "pr_number": pr_number}
