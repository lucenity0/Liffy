import hashlib
import hmac
import json

import httpx
import pytest
from conftest import seed_user
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api import webhook as webhook_api
from app.config import settings
from app.database import Base, get_db
from app.main import app
from app.models.repository import Repository

WEBHOOK_SECRET = "test-webhook-secret"

client = TestClient(app)


@pytest.fixture(autouse=True)
def _fixed_webhook_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pin the secret so the test does not depend on the ambient .env value.
    monkeypatch.setattr(settings, "github_webhook_secret", WEBHOOK_SECRET)


@pytest.fixture(autouse=True)
def connected_repo():
    """A connected octo/demo, since the webhook now ignores unknown repos.

    Autouse so every existing test keeps its original meaning: the deliveries
    they assert on are for a repository somebody has actually connected.
    """
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)

    with factory() as db:
        user = seed_user(db, github_id=1, username="octo")
        db.add(Repository(user_id=user.id, github_repo_id=9, full_name="octo/demo"))
        db.commit()

    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    yield factory
    app.dependency_overrides.clear()


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


def _signed(body: bytes) -> "httpx.Response":
    return client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-Hub-Signature-256": _signature(WEBHOOK_SECRET, body),
            "Content-Type": "application/json",
        },
    )


def _post(payload: dict) -> "httpx.Response":
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


def test_webhook_malformed_json_returns_400(enqueued) -> None:
    # Valid signature but non-JSON body must not 500 (which GitHub would retry).
    response = _signed(b"not json at all")
    assert response.status_code == 400
    assert enqueued == []


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


def test_webhook_still_works_without_auth(enqueued) -> None:
    """GitHub cannot present a JWT; HMAC is this route's authentication.

    Requiring a bearer token here would break every real delivery.
    """
    response = _post(PR_OPENED)

    assert response.status_code == 200
    assert "authorization" not in {k.lower() for k in response.request.headers}
    assert enqueued == [("octo", "demo", 7)]


def test_webhook_for_unknown_repo_is_ignored(enqueued) -> None:
    """A delivery for a repository nobody connected has no owner.

    Before AUTH-4 a phantom system user absorbed these, so an unsolicited
    webhook could create rows in the database.
    """
    response = _post(dict(PR_OPENED, repository={"full_name": "stranger/unknown"}))

    assert response.status_code == 200
    assert response.json()["status"] == "ignored"
    assert enqueued == []
