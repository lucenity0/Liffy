"""Async codebase indexing task (report §7.1). Enqueued when a repository is
connected or re-indexing is requested (BASE-10's POST /repos/{id}/index)."""

import uuid

from app.database import SessionLocal
from app.llm.embeddings import get_embedding_provider
from app.models.repository import Repository
from app.services.github_service import GitHubClient
from app.services.indexer import index_repository
from app.services.rag_service import get_chroma_client
from app.workers.celery_app import celery


@celery.task(name="liffy.index_repo")
def index_repo_task(repo_id: str) -> dict:
    db = SessionLocal()
    try:
        repo = db.get(Repository, uuid.UUID(repo_id))
        if repo is None:
            return {"status": "missing", "repo_id": repo_id}
        gh = GitHubClient()
        try:
            result = index_repository(
                db,
                repo,
                gh=gh,
                chroma_client=get_chroma_client(),
                embedder=get_embedding_provider(),
            )
        finally:
            gh.close()
        return {
            "status": "ok",
            "repo_id": repo_id,
            "files_seen": result.files_seen,
            "chunks_added": result.chunks_added,
            "chunks_skipped": result.chunks_skipped,
            "chunks_deleted": result.chunks_deleted,
        }
    finally:
        db.close()


def enqueue_index(repo_id: uuid.UUID) -> None:
    """API-facing wrapper; tests monkeypatch this instead of Celery."""
    index_repo_task.delay(str(repo_id))
