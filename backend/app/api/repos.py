import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.repo_embedding import RepoEmbedding
from app.models.repository import Repository
from app.schemas.repo import RepoConnectRequest, RepoOut, RepoStatusOut
from app.services.github_service import GitHubAuthError, GitHubClient, GitHubError
from app.services.rag_service import collection_name, get_chroma_client
from app.services.review_service import _ensure_system_user
from app.workers import index_worker

router = APIRouter()


def _get_repo_or_404(db: Session, repo_id: uuid.UUID) -> Repository:
    repo = db.get(Repository, repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="Repository not found")
    return repo


@router.post("", status_code=201, response_model=RepoOut)
def connect_repo(payload: RepoConnectRequest, db: Session = Depends(get_db)) -> Repository:
    """Connect a GitHub repository and queue its first indexing run.

    Idempotent: reconnecting an already-connected repo re-queues indexing.
    """
    existing = db.scalar(select(Repository).where(Repository.full_name == payload.full_name))
    if existing is not None:
        index_worker.enqueue_index(existing.id)
        return existing

    owner, name = payload.full_name.split("/", 1)
    try:
        with GitHubClient() as gh:
            meta = gh.get_repository(owner, name)
    except GitHubAuthError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except GitHubError as exc:
        raise HTTPException(status_code=502, detail=f"GitHub error: {exc}") from exc

    repo = Repository(
        user_id=_ensure_system_user(db).id,
        github_repo_id=meta.id,
        full_name=meta.full_name,
        default_branch=meta.default_branch,
    )
    db.add(repo)
    db.commit()
    index_worker.enqueue_index(repo.id)
    return repo


@router.get("", response_model=list[RepoOut])
def list_repos(db: Session = Depends(get_db)) -> list[Repository]:
    return list(db.scalars(select(Repository).order_by(Repository.created_at.desc())))


@router.delete("/{repo_id}", status_code=204)
def disconnect_repo(repo_id: uuid.UUID, db: Session = Depends(get_db)) -> None:
    repo = _get_repo_or_404(db, repo_id)
    try:
        get_chroma_client().delete_collection(collection_name(repo.id))
    except Exception:  # collection may not exist yet; DB row removal still proceeds
        pass
    db.delete(repo)  # FK cascades remove PRs/reviews/embedding rows
    db.commit()


@router.post("/{repo_id}/index", status_code=202)
def trigger_index(repo_id: uuid.UUID, db: Session = Depends(get_db)) -> dict[str, str]:
    repo = _get_repo_or_404(db, repo_id)
    index_worker.enqueue_index(repo.id)
    return {"repo_id": str(repo.id), "status": "queued"}


@router.get("/{repo_id}/status", response_model=RepoStatusOut)
def repo_status(repo_id: uuid.UUID, db: Session = Depends(get_db)) -> RepoStatusOut:
    repo = _get_repo_or_404(db, repo_id)
    chunk_count = db.scalar(
        select(func.count())
        .select_from(RepoEmbedding)
        .where(RepoEmbedding.repo_id == repo.id)
    )
    return RepoStatusOut(
        id=repo.id,
        full_name=repo.full_name,
        status="indexed" if repo.indexed_at else "not_indexed",
        indexed_at=repo.indexed_at,
        chunk_count=int(chunk_count or 0),
    )
