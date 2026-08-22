"""Async codebase indexing task (report §7.1). Enqueued when a repository is
connected or re-indexing is requested (BASE-10's POST /repos/{id}/index)."""

import logging
import uuid

from app.database import SessionLocal
from app.llm.embeddings import get_embedding_provider
from app.models.repository import Repository
from app.models.user import User
from app.services.github_service import GitHubAuthError, GitHubClient
from app.services.indexer import index_repository
from app.services.rag_service import get_chroma_client
from app.workers.celery_app import celery

logger = logging.getLogger(__name__)


# `acks_late` here and deliberately *not* on the review task. Both settings
# mean "redeliver this message if the worker dies holding it", and that is only
# safe for work that can be repeated for free. Indexing can: it is idempotent
# by content hash, so a re-run re-embeds only what changed and a half-finished
# run has written nothing (the stale-cleanup and `indexed_at` are its last two
# steps). A review cannot — a redelivered one re-bills tokens and writes a
# second row, which is why `review_worker` documents no autoretry.
#
# Without this, an OOM-killed index was acknowledged on delivery and gone:
# the queue emptied, no row changed, and the UI kept saying "queued" forever.
@celery.task(
    name="liffy.index_repo",
    acks_late=True,
    reject_on_worker_lost=True,
)
def index_repo_task(repo_id: str) -> dict:
    db = SessionLocal()
    try:
        repo = db.get(Repository, uuid.UUID(repo_id))
        if repo is None:
            return {"status": "missing", "repo_id": repo_id}
        # No request context here: act as the repository's owner, whose token
        # is the one guaranteed to reach it.
        owner = db.get(User, repo.user_id)
        try:
            gh = GitHubClient(token=owner.github_access_token if owner else None)
        except GitHubAuthError as exc:
            # `GitHubClient` no longer falls back to the instance PAT, so an
            # owner with no stored token fails here. The `except Exception`
            # below would clear `indexing_started_at` and re-raise, leaving a
            # traceback in the worker log and a repository that just looks
            # un-indexed. Named instead — same guard `review_worker` carries,
            # for the same reason.
            repo.indexing_started_at = None
            db.commit()
            logger.warning("index skipped for %s: %s", repo.full_name, exc)
            return {"status": "skipped", "repo_id": repo_id,
                    "reason": "owner has no GitHub token"}
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
            # This dict is the only place the count reaches a caller — the
            # fields are enumerated, so a counter left out here is invisible
            # outside the worker log, which is the thing it exists to avoid.
            "files_failed": result.files_failed,
        }
    except Exception:
        # A failed task must not strand the repository in the in-flight state.
        # Roll back first so partial ORM work from a failed run is not
        # accidentally committed alongside the marker cleanup.
        db.rollback()
        failed_repo = db.get(Repository, uuid.UUID(repo_id))
        if failed_repo is not None and failed_repo.indexing_started_at is not None:
            failed_repo.indexing_started_at = None
            db.commit()
        raise
    finally:
        db.close()


def enqueue_index(repo_id: uuid.UUID) -> None:
    """API-facing wrapper; tests monkeypatch this instead of Celery."""
    index_repo_task.delay(str(repo_id))
