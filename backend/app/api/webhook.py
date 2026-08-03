import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.services.github_service import verify_webhook_signature
from app.services.review_service import resolve_repo_owner
from app.workers import review_worker

router = APIRouter()

# PR events that warrant a (re-)review (report §3.1 step 02).
_REVIEWABLE_ACTIONS = {"opened", "synchronize", "reopened"}


# Deliberately unauthenticated: GitHub cannot present a JWT. This route is
# authenticated by HMAC signature instead, which is the correct mechanism for
# it — requiring a bearer token would break every real webhook delivery.
@router.post("/github")
async def github_webhook(
    request: Request,
    x_hub_signature_256: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict[str, str | int]:
    body = await request.body()
    if not verify_webhook_signature(settings.github_webhook_secret, body, x_hub_signature_256):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid signature")

    # Report §8.1's clock starts here — the "webhook received" its < 90s target
    # is measured from. The placement is load-bearing in both directions:
    # earlier would include a slow client's upload, letting anyone deflate the
    # metric by trickling a body; later would hide the JSON parse and the
    # `resolve_repo_owner` round trip, which are real work a user waits through.
    #
    # `timezone.utc` explicitly — a naive `datetime.now()` records the API
    # host's offset as latency, and the worker reading it is a different process
    # that may not share the host.
    received_at = datetime.now(timezone.utc)

    try:
        payload = json.loads(body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        # Signature was valid but the body is malformed: return 4xx so GitHub
        # records a client error instead of retrying on a 500.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Malformed JSON body"
        ) from exc
    pull_request = payload.get("pull_request")
    action = payload.get("action")
    full_name = (payload.get("repository") or {}).get("full_name", "")

    if not pull_request or action not in _REVIEWABLE_ACTIONS or "/" not in full_name:
        # 200 so GitHub does not retry pings/irrelevant events.
        return {"status": "ignored"}

    # A delivery for a repository nobody connected has no owner to attribute the
    # review to. Ignored rather than absorbed by a phantom user (AUTH-4), which
    # let an unsolicited webhook create rows. Checked here rather than in the
    # worker so the work is never queued.
    if resolve_repo_owner(db, full_name) is None:
        return {"status": "ignored", "reason": "repository not connected"}

    owner, repo_name = full_name.split("/", 1)
    pr_number = int(pull_request["number"])
    review_worker.enqueue_review(owner, repo_name, pr_number, received_at.isoformat())
    return {"status": "queued", "pr_number": pr_number}
