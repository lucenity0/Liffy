import json

from fastapi import APIRouter, Header, HTTPException, Request, status

from app.config import settings
from app.services.github_service import verify_webhook_signature
from app.workers import review_worker

router = APIRouter()

# PR events that warrant a (re-)review (report §3.1 step 02).
_REVIEWABLE_ACTIONS = {"opened", "synchronize", "reopened"}


@router.post("/github")
async def github_webhook(
    request: Request,
    x_hub_signature_256: str | None = Header(default=None),
) -> dict[str, str | int]:
    body = await request.body()
    if not verify_webhook_signature(settings.github_webhook_secret, body, x_hub_signature_256):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid signature")

    try:
        payload = json.loads(body.decode("utf-8") or "{}")
    except json.JSONDecodeError as exc:
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

    owner, repo_name = full_name.split("/", 1)
    pr_number = int(pull_request["number"])
    review_worker.enqueue_review(owner, repo_name, pr_number)
    return {"status": "queued", "pr_number": pr_number}
