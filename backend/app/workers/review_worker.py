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
from app.llm.chain import OpenAIReviewLLM
from app.llm.embeddings import get_embedding_provider
from app.services.github_service import GitHubClient
from app.services.rag_service import get_chroma_client
from app.services.review_service import run_review
from app.workers.celery_app import celery


@celery.task(name="liffy.review_pr")
def review_pr_task(owner: str, repo_name: str, pr_number: int) -> dict:
    db = SessionLocal()
    gh = GitHubClient()
    try:
        review = run_review(
            db,
            owner,
            repo_name,
            pr_number,
            gh=gh,
            chroma_client=get_chroma_client(),
            embedder=get_embedding_provider(),
            llm=OpenAIReviewLLM(),
        )
        return {"review_id": str(review.id), "status": review.status}
    finally:
        gh.close()
        db.close()


def enqueue_review(owner: str, repo_name: str, pr_number: int) -> None:
    """API-facing wrapper; tests monkeypatch this instead of Celery."""
    review_pr_task.delay(owner, repo_name, pr_number)
