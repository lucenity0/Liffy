import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from app.api import webhook as webhook_api
from app.config import settings
from app.main import app

WEBHOOK_SECRET = "test-webhook-secret"

client = TestClient(app)


@pytest.fixture(autouse=True)
def _fixed_webhook_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pin the secret so the test does not depend on the ambient .env value.
    monkeypatch.setattr(settings, "github_webhook_secret", WEBHOOK_SECRET)


@pytest.fixture()
def enqueued(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, int]]:
    calls: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        webhook_api.review_worker,
        "enqueue_review",
        lambda owner, repo, pr: calls.append((owner, repo, pr)),
    )
    return calls


def _signature(secret: str, body: bytes) -> str:
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def _post(payload: dict) -> "TestClient.Response":
    body = json.dumps(payload).encode("utf-8")
    return client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-Hub-Signature-256": _signature(WEBHOOK_SECRET, body),
            "Content-Type": "application/json",
        },
    )


PR_OPENED = {
    "action": "opened",
    "pull_request": {"number": 7},
    "repository": {"full_name": "octo/demo"},
}


def test_webhook_rejects_invalid_signature(enqueued) -> None:
    response = client.post("/webhook/github", json=PR_OPENED)
    assert response.status_code == 401
    assert enqueued == []


def test_webhook_queues_review_on_pr_opened(enqueued) -> None:
    response = _post(PR_OPENED)
    assert response.status_code == 200
    assert response.json() == {"status": "queued", "pr_number": 7}
    assert enqueued == [("octo", "demo", 7)]


def test_webhook_queues_on_synchronize(enqueued) -> None:
    response = _post(dict(PR_OPENED, action="synchronize"))
    assert response.json()["status"] == "queued"
    assert len(enqueued) == 1


def test_webhook_ignores_irrelevant_events(enqueued) -> None:
    for payload in (
        {},  # ping-like
        dict(PR_OPENED, action="closed"),  # non-reviewable action
        {"action": "opened", "pull_request": {"number": 7}},  # no repository
    ):
        response = _post(payload)
        assert response.status_code == 200
        assert response.json() == {"status": "ignored"}
    assert enqueued == []
