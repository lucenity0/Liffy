import hashlib
import hmac
import json

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _signature(secret: str, payload: dict) -> str:
    body = json.dumps(payload).encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def test_webhook_rejects_invalid_signature() -> None:
    response = client.post("/webhook/github", json={"pull_request": {"number": 7}})
    assert response.status_code == 401


def test_webhook_accepts_valid_signature() -> None:
    payload = {"pull_request": {"number": 7}}
    sig = _signature("change-me", payload)
    response = client.post("/webhook/github", json=payload, headers={"X-Hub-Signature-256": sig})
    assert response.status_code == 200
    assert response.json() == {"status": "queued", "pr_number": 7}
