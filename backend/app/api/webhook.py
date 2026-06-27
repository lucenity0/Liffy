import json

from fastapi import APIRouter, Header, HTTPException, Request, status

from app.config import settings
from app.services.github_service import verify_webhook_signature

router = APIRouter()


@router.post("/github")
async def github_webhook(
    request: Request,
    x_hub_signature_256: str | None = Header(default=None),
) -> dict[str, str | int]:
    body = await request.body()
    if not verify_webhook_signature(settings.github_webhook_secret, body, x_hub_signature_256):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid signature")

    payload = json.loads(body.decode("utf-8") or "{}")
    pr_number = payload.get("pull_request", {}).get("number", 0)
    return {"status": "queued", "pr_number": pr_number}
