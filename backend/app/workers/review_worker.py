"""Async review generation task (report §3.1 steps 06-12).

The API enqueues via ``enqueue_review``; the Celery worker executes
``review_pr_task``. Dependencies are constructed inside the task so the
worker process owns its own connections.

No Celery-level autoretry: LLM validation retries happen inside the chain
(BASE-7), and pipeline failures are recorded on the review row as
``status="failed"`` — blind re-runs would re-bill tokens on deterministic
failures.
"""

from datetime import datetime, timezone

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


def _parse_received_at(value: str | None) -> datetime | None:
    """Webhook receipt time, back from Celery's JSON.

    A metric is never worth failing a review over: an unparseable value
    degrades to ``None`` — ``total_ms`` stays NULL — rather than raising, so a
    bad timestamp costs one row of analytics and not the review itself.

    A *naive* string is refused rather than assumed to be UTC. Assuming would
    silently record the API host's timezone offset as latency: on a machine at
    UTC+05:30 that is a 5.5-hour "queue wait", which is much worse than no
    number at all.
    """
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


@celery.task(name="liffy.review_pr")
def review_pr_task(
    owner: str, repo_name: str, pr_number: int, received_at: str | None = None
) -> dict:
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
                received_at=_parse_received_at(received_at),
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


def enqueue_review(
    owner: str, repo_name: str, pr_number: int, received_at: str | None = None
) -> None:
    """API-facing wrapper; tests monkeypatch this instead of Celery.

    ``received_at`` is an ISO-8601 string and not a ``datetime`` because
    ``celery_app`` sets ``task_serializer="json"``: a ``datetime`` fails at
    ``.delay()`` rather than at execution, so it surfaces as a broker error
    and reads like an infrastructure fault.

    Optional, with two reasons rather than one. Manual triggers and re-reviews
    have no webhook receipt, and on a rolling deploy a message enqueued by the
    old three-argument code must still execute rather than raising
    ``TypeError``. A default absorbs both. It does not absorb the opposite
    order, so deploy workers before the API.
    """
    review_pr_task.delay(owner, repo_name, pr_number, received_at)
