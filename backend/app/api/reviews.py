import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.database import get_db
from app.models.comment_feedback import CommentFeedback
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.review_comment import ReviewComment
from app.models.user import User
from app.schemas.review import (
    LatestFindingOut,
    ReviewCommentOut,
    ReviewDetailOut,
    ReviewListItem,
    ReviewListPage,
    ReviewOut,
    ReviewStatus,
)
from app.services.github_service import GitHubClient
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


@router.get("/reviews", response_model=ReviewListPage)
def list_reviews(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    repo_id: uuid.UUID | None = Query(default=None),
    pr_number: int | None = Query(default=None, gt=0),
    status: ReviewStatus | None = Query(default=None),
    include_failed: bool = Query(default=True),
    sort: Literal["newest", "oldest"] = Query(default="newest"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ReviewListPage:
    """One page of the caller's reviews, filtered and sorted.

    Re-reviewing a PR appends a new row rather than replacing one, so with a
    few repositories connected the unfiltered stream is mostly the same PR
    several times over. Every filter below narrows that; none of them widens
    what the caller can see.

    ``repo_id`` rather than ``full_name`` deliberately: an id is stable across
    a repository rename, and it is what the frontend already holds.
    """
    # The ownership filter rides the join this query already performed rather
    # than costing a second round trip per row.
    #
    # It is also applied *first*, and every filter below is AND-ed on top of
    # it. That ordering is the security property: a `repo_id` belonging to
    # somebody else narrows an already-owned set to nothing, so it returns an
    # empty page rather than their reviews. A filter that replaced this clause
    # instead of joining it would be a data leak wearing a UI feature's
    # clothes, which is why `test_list_reviews_repo_filter_cannot_reach_other_
    # users_reviews` exists.
    owned = (
        select(Review, PullRequest.github_pr_number, Repository.full_name)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(Repository.user_id == user.id)
    )

    # Each of these is a WHERE on a join that has already happened — no extra
    # round trips, and `status` rides the existing `ix_reviews_status`.
    if repo_id is not None:
        owned = owned.where(Repository.id == repo_id)
    if pr_number is not None:
        owned = owned.where(PullRequest.github_pr_number == pr_number)
    if status is not None:
        owned = owned.where(Review.status == status)

    # Not `status="completed"` with a different name. The dashboard wants
    # everything *except* failures — a queued or in-flight review is the most
    # interesting row on that page, and filtering to completed would hide the
    # async behaviour the product is built around.
    #
    # Defaults to True so every existing caller keeps its current answer, and
    # `total` narrows with it: a count that included failures over a page that
    # excluded them would offer a Next leading nowhere, which is the same bug
    # the envelope exists to prevent.
    #
    # Combining this with `status="failed"` is contradictory and returns an
    # empty page rather than erroring — the two filters AND like every other
    # pair here, and no caller sends both.
    if not include_failed:
        owned = owned.where(Review.status != "failed")

    ordering = (
        Review.created_at.asc() if sort == "oldest" else Review.created_at.desc()
    )

    rows = db.execute(owned.order_by(ordering).limit(limit).offset(offset)).all()

    # Counted over the same selectable, minus the ordering and the window, so
    # the total can never describe a different set than the page does. A second
    # hand-written query would be free to drift away from the first.
    total = db.scalar(
        select(func.count()).select_from(owned.order_by(None).subquery())
    )

    return ReviewListPage(
        items=[
            ReviewListItem(
                **ReviewOut.model_validate(review).model_dump(),
                pr_number=pr_number,
                repo_full_name=full_name,
            )
            for review, pr_number, full_name in rows
        ],
        total=total or 0,
    )


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


class CommitOut(BaseModel):
    sha: str
    message: str
    author: str
    committed_at: str
    #: True when this commit landed after the last completed review of this PR.
    is_new: bool


class ReviewCommitsRequest(BaseModel):
    #: Full 40-character SHAs, as returned by the commits endpoint above.
    shas: list[str] = Field(min_length=1, max_length=50)


def _owned_pr_or_404(
    db: Session, pr_id: uuid.UUID, user: User
) -> tuple[str, str, int]:
    """`(owner, repo, pr_number)` for a pull request this caller owns.

    Scoped through the owning repository like every other read here, so
    somebody else's pull request is indistinguishable from one that does not
    exist rather than being quietly readable.
    """
    row = db.execute(
        select(Repository.full_name, PullRequest.github_pr_number)
        .join(PullRequest, PullRequest.repo_id == Repository.id)
        .where(PullRequest.id == pr_id, Repository.user_id == user.id)
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Pull request not found")

    owner, repo_name = row.full_name.split("/", 1)
    return owner, repo_name, row.github_pr_number


@router.get("/prs/{pr_id}/commits", response_model=list[CommitOut])
def list_pr_commits(
    pr_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[CommitOut]:
    """Commits on a pull request, flagged with which are new since the review.

    Backs the picker. `is_new` rather than filtering the old ones away: seeing
    what was already reviewed is what makes "since" mean anything, and a list
    that silently omits half a pull request's history invites the question of
    where the rest went.

    "Since" is measured from `head_sha` on the last completed review. A pull
    request with no completed review has no boundary, so everything reads as
    new — which is true.
    """
    owner, repo_name, pr_number = _owned_pr_or_404(db, pr_id, user)

    reviewed_sha = db.scalar(
        select(Review.head_sha)
        .where(
            Review.pr_id == pr_id,
            Review.status == "completed",
            Review.head_sha.is_not(None),
        )
        .order_by(Review.created_at.desc())
        .limit(1)
    )

    gh = GitHubClient(token=user.github_access_token)
    commits = gh.list_pull_request_commits(owner, repo_name, pr_number)

    # Walked in order rather than compared by timestamp. Commit dates are
    # *author* dates and can run backwards relative to the order commits
    # actually landed — a rebase or a cherry-pick is enough to make a
    # chronological split wrong.
    seen_boundary = reviewed_sha is None
    out: list[CommitOut] = []
    for commit in commits:
        out.append(
            CommitOut(
                sha=commit.sha,
                message=commit.message,
                author=commit.author,
                committed_at=commit.committed_at,
                is_new=seen_boundary,
            )
        )
        if commit.sha == reviewed_sha:
            seen_boundary = True

    # The boundary was never found, so a force-push rewrote it away. Nothing
    # here is *known* to have been reviewed, and saying so is more honest than
    # marking commits old on the strength of a commit that no longer exists.
    if reviewed_sha is not None and not seen_boundary:
        out = [c.model_copy(update={"is_new": True}) for c in out]

    return out


@router.post("/prs/{pr_id}/review-commits", status_code=202)
def review_commits(
    pr_id: uuid.UUID,
    payload: ReviewCommitsRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Review only the files the selected commits touched.

    The selection picks *files*, and those files are reviewed as they stand at
    the pull request's head — not as the selected commits left them. So
    skipping a commit in the middle cannot produce stale line numbers, and a
    file touched by both a selected and an unselected commit is read whole.
    """
    owner, repo_name, pr_number = _owned_pr_or_404(db, pr_id, user)

    review_worker.enqueue_review(
        owner, repo_name, pr_number, commit_shas=payload.shas
    )
    return {
        "status": "queued",
        "repo": f"{owner}/{repo_name}",
        "pr_number": pr_number,
        "commits": len(payload.shas),
    }


# Declared before `/reviews/{review_id}`, and that ordering is load-bearing:
# FastAPI matches routes in definition order, so with this below the detail
# route "latest-finding" is handed to it as a `review_id` and answers 422
# against a UUID parse. Moving it down is a silent break with a confusing
# error, which is why `test_latest_finding_is_not_parsed_as_a_review_id`
# exists.
@router.get("/reviews/latest-finding", response_model=LatestFindingOut | None)
def latest_finding(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> LatestFindingOut | None:
    """The most recent finding worth showing, or ``None``.

    The dashboard opens on counts, which say a job ran; this says the product
    works. One comment, from the newest completed review that produced any.

    **The inner join is doing the selection.** A review with no comments has
    no rows here at all, so "most recent completed review that actually found
    something" falls out of `ORDER BY created_at DESC LIMIT 1` for free —
    without it, a clean pull request (which is a *good* outcome Liffy is meant
    to produce) would blank the band until the next PR came in.

    Within that review, the worst finding wins. Severity is a string column,
    so the rank is spelled here rather than sorted alphabetically — which
    would order critical, info, warning, and put the least urgent finding in
    the middle.

    `failed` reviews are excluded by the status filter, not merely sorted
    below: a failed review has no comments to show anyway, and the dashboard
    is not where an error belongs.
    """
    severity_rank = case(
        (ReviewComment.severity == "critical", 0),
        (ReviewComment.severity == "warning", 1),
        else_=2,
    )

    # The ownership filter rides the join, exactly as `list_reviews` does it —
    # the same security property, applied first and never widened.
    row = db.execute(
        select(
            ReviewComment,
            Review.id,
            Review.created_at,
            PullRequest.github_pr_number,
            Repository.full_name,
        )
        .join(Review, ReviewComment.review_id == Review.id)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(Repository.user_id == user.id, Review.status == "completed")
        .order_by(Review.created_at.desc(), severity_rank)
        .limit(1)
    ).first()

    if row is None:
        return None

    comment, review_id, reviewed_at, pr_number, full_name = row
    return LatestFindingOut(
        review_id=review_id,
        pr_number=pr_number,
        repo_full_name=full_name,
        reviewed_at=reviewed_at,
        # `my_rating` is left at its default: the dashboard shows the finding,
        # it does not ask you to rate it. Rating lives on the detail page,
        # where the suggestion it is rating is also on screen.
        comment=ReviewCommentOut.model_validate(comment),
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
