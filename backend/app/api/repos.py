import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.database import get_db
from app.models.repo_embedding import RepoEmbedding
from app.models.repository import Repository
from app.models.user import User
from app.schemas.repo import (
    PullRequestListOut,
    PullRequestOut,
    RepoConnectRequest,
    RepoOut,
    RepoStatusOut,
)
from app.services.github_service import (
    GitHubAuthError,
    GitHubClient,
    GitHubError,
    GitHubRateLimitError,
)
from app.services.rag_service import collection_name, get_chroma_client
from app.workers import index_worker

router = APIRouter()


def _queue_index(repo: Repository, db: Session) -> None:
    """Persist an in-flight marker before handing work to Celery."""
    repo.indexing_started_at = datetime.now(timezone.utc)
    db.commit()
    try:
        index_worker.enqueue_index(repo.id)
    except Exception:
        # Do not leave a permanently "indexing" repository when the broker is
        # unavailable. The last successful indexed_at remains truthful.
        repo.indexing_started_at = None
        db.commit()
        raise


def _get_repo_or_404(db: Session, repo_id: uuid.UUID, user: User) -> Repository:
    """Fetch one of the caller's repositories.

    Someone else's repository is a 404, not a 403: a 403 confirms the row
    exists, which is itself the information leak. Every route here answers the
    same way, because one route differing would leak by comparison.
    """
    repo = db.scalar(
        select(Repository).where(Repository.id == repo_id, Repository.user_id == user.id)
    )
    if repo is None:
        raise HTTPException(status_code=404, detail="Repository not found")
    return repo


@router.post("", status_code=201, response_model=RepoOut)
def connect_repo(
    payload: RepoConnectRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Repository:
    """Connect a GitHub repository and queue its first indexing run.

    Idempotent per user: reconnecting your own repo re-queues indexing.
    """
    # Scoped to the caller. Without the user_id filter, connecting a repo
    # someone else had already connected would hand back *their* row and
    # re-queue indexing on it, since full_name has no unique constraint.
    existing = db.scalar(
        select(Repository).where(
            Repository.full_name == payload.full_name, Repository.user_id == user.id
        )
    )
    if existing is not None:
        _queue_index(existing, db)
        return existing

    owner, name = payload.full_name.split("/", 1)
    try:
        # Acts as the caller, not as the server-side PAT. This is the seam
        # BASE-3 left open, finally used.
        with GitHubClient(token=user.github_access_token) as gh:
            meta = gh.get_repository(owner, name)
    # Rate limit before auth: both are `GitHubError` subclasses and
    # `GitHubRateLimitError` is the more specific one, so an `except` chain in
    # the other order would never reach it. A 429 with `Retry-After` is the
    # honest answer — it says "wait", where the 503 below says "reconnect",
    # and only one of those is something the user can act on here.
    except GitHubRateLimitError as exc:
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
        raise HTTPException(status_code=429, detail=str(exc), headers=headers) from exc
    except GitHubAuthError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except GitHubError as exc:
        raise HTTPException(status_code=502, detail=f"GitHub error: {exc}") from exc

    repo = Repository(
        user_id=user.id,
        github_repo_id=meta.id,
        full_name=meta.full_name,
        default_branch=meta.default_branch,
    )
    db.add(repo)
    _queue_index(repo, db)
    return repo


@router.get("", response_model=list[RepoOut])
def list_repos(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[Repository]:
    return list(
        db.scalars(
            select(Repository)
            .where(Repository.user_id == user.id)
            .order_by(Repository.created_at.desc())
        )
    )


@router.delete("/{repo_id}", status_code=204)
def disconnect_repo(
    repo_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    repo = _get_repo_or_404(db, repo_id, user)
    try:
        get_chroma_client().delete_collection(collection_name(repo.id))
    except Exception:  # collection may not exist yet; DB row removal still proceeds
        pass
    db.delete(repo)  # FK cascades remove PRs/reviews/embedding rows
    db.commit()


@router.post("/{repo_id}/index", status_code=202)
def trigger_index(
    repo_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, str]:
    repo = _get_repo_or_404(db, repo_id, user)
    # Keep the last successful indexed_at while the new task is in flight.
    # Commit before enqueueing so the worker and the next status poll observe
    # the same state even when the task starts immediately.
    _queue_index(repo, db)
    return {"repo_id": str(repo.id), "status": "queued"}


@router.get("/{repo_id}/status", response_model=RepoStatusOut)
def repo_status(
    repo_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RepoStatusOut:
    repo = _get_repo_or_404(db, repo_id, user)
    chunk_count = db.scalar(
        select(func.count())
        .select_from(RepoEmbedding)
        .where(RepoEmbedding.repo_id == repo.id)
    )
    return RepoStatusOut(
        id=repo.id,
        full_name=repo.full_name,
        status=(
            "indexing"
            if repo.indexing_started_at
            else "indexed"
            if repo.indexed_at
            else "not_indexed"
        ),
        indexed_at=repo.indexed_at,
        chunk_count=int(chunk_count or 0),
        last_index_failed_files=repo.last_index_failed_files,
        last_indexed_files_seen=repo.last_indexed_files_seen,
    )


# How many pull requests one page holds. A picker, not a browser: this is
# meant to cover "the one I just opened", and anything older is reachable by
# number. Also the boundary that makes `total` knowable — see below.
_PULLS_PAGE = 50


@router.get("/{repo_id}/pulls", response_model=PullRequestListOut)
def list_repo_pulls(
    repo_id: uuid.UUID,
    state: str = "open",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PullRequestListOut:
    """Pull requests on a connected repository, for the review picker.

    Exists so starting a review does not begin with reading a number off a
    GitHub URL. Proxied rather than stored: pull requests change constantly
    and Liffy has no business holding a stale copy of them, so nothing here
    touches the database beyond the ownership check.

    Acts as the caller, like every other repository route — the server-side
    PAT would let someone list pull requests on a repository their own token
    cannot see.
    """
    if state not in {"open", "closed", "all"}:
        raise HTTPException(
            status_code=422, detail="state must be open, closed or all"
        )

    repo = _get_repo_or_404(db, repo_id, user)
    owner, name = repo.full_name.split("/", 1)

    try:
        with GitHubClient(token=user.github_access_token) as gh:
            pulls = gh.list_pull_requests(owner, name, state=state, limit=_PULLS_PAGE)
    # Same ordering as connect_repo: rate limit is the more specific error and
    # has to be caught before the auth case it inherits from.
    except GitHubRateLimitError as exc:
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
        raise HTTPException(status_code=429, detail=str(exc), headers=headers) from exc
    except GitHubAuthError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except GitHubError as exc:
        raise HTTPException(status_code=502, detail=f"GitHub error: {exc}") from exc

    return PullRequestListOut(
        items=[
            PullRequestOut(
                number=pull.number,
                title=pull.title,
                author=pull.author,
                head_branch=pull.head_branch,
                base_branch=pull.base_branch,
                state=pull.state,
            )
            for pull in pulls
        ],
        state=state,
        # Only when the page came back short, which is the only case where it
        # is provably the whole set. A full page means "at least 50", and
        # reporting that as a total would be a number the UI then shows as
        # fact.
        total=len(pulls) if len(pulls) < _PULLS_PAGE else None,
    )
