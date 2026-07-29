"""Async review generation task (report §3.1 steps 06-12).

The API enqueues via ``enqueue_review``; the Celery worker executes
``review_pr_task``. Dependencies are constructed inside the task so the
worker process owns its own connections.

No Celery-level autoretry: LLM validation retries happen inside the chain
(BASE-7), and pipeline failures are recorded on the review row as
``status="failed"`` — blind re-runs would re-bill tokens on deterministic
failures.
"""

from app.database import SessionLocal
from app.llm.chain import get_llm
from app.llm.embeddings import get_embedding_provider
from app.services.github_service import GitHubClient
from app.services.rag_service import get_chroma_client
from app.services.review_service import (
    RepositoryNotConnected,
    resolve_repo_owner,
    run_review,
)
from app.workers.celery_app import celery


@celery.task(name="liffy.review_pr")
def review_pr_task(owner: str, repo_name: str, pr_number: int) -> dict:
    db = SessionLocal()
    try:
        # No request context here, so the token comes from the repository's
        # owner. Resolving from the owner rather than whoever triggered the
        # run is also what stops user B's re-review from failing on a private
        # repo only user A can see.
        owner_user = resolve_repo_owner(db, f"{owner}/{repo_name}")
        if owner_user is None:
            return {"status": "ignored", "repo": f"{owner}/{repo_name}"}

        # inside try so db.close() runs even if this raises
        gh = GitHubClient(token=owner_user.github_access_token)
        try:
            review = run_review(
                db,
                owner,
                repo_name,
                pr_number,
                gh=gh,
                chroma_client=get_chroma_client(),
                embedder=get_embedding_provider(),
                llm=get_llm(),
            )
            return {"review_id": str(review.id), "status": review.status}
        except RepositoryNotConnected:
            # The webhook already filters these, so reaching here means the
            # repo was disconnected between enqueue and execution. Not an
            # error worth retrying — there is nobody to own the result.
            return {"status": "ignored", "repo": f"{owner}/{repo_name}"}
        finally:
            gh.close()
    finally:
        db.close()


def enqueue_review(owner: str, repo_name: str, pr_number: int) -> None:
    """API-facing wrapper; tests monkeypatch this instead of Celery."""
    review_pr_task.delay(owner, repo_name, pr_number)
