import uuid
from datetime import datetime, timedelta, timezone

import pytest
from conftest import auth_headers, seed_user
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api import reviews as reviews_api
from app.database import Base, get_db
from app.main import app
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.review_comment import ReviewComment
from app.models.user import User

client = TestClient(app)

T0 = datetime(2026, 7, 1, tzinfo=timezone.utc)

RAW_DIFF = "diff --git a/a.py b/a.py\n@@ -1,2 +1,2 @@\n-old\n+new\n"


def _seed_reviews(db, user: User, full_name: str, summaries: tuple[str, str]) -> dict:
    """One repo + PR + two reviews (older, newer) owned by ``user``."""
    repo = Repository(user_id=user.id, github_repo_id=9, full_name=full_name)
    db.add(repo)
    db.flush()
    pr = PullRequest(
        repo_id=repo.id, github_pr_number=7, title="Fix", author="octo",
        base_branch="main", head_branch="fix", status="open",
    )
    db.add(pr)
    db.flush()
    old = Review(pr_id=pr.id, status="completed", summary=summaries[0], verdict="approve",
                 model_used="m", tokens_used=10, created_at=T0)
    new = Review(pr_id=pr.id, status="completed", summary=summaries[1], verdict="comment",
                 model_used="m", tokens_used=20, created_at=T0 + timedelta(hours=1),
                 raw_diff=RAW_DIFF)
    db.add_all([old, new])
    db.flush()
    db.add(ReviewComment(
        review_id=new.id, file_path="a.py", line_start=1, line_end=2,
        category="logic_error", severity="warning", comment_text="Bug.", suggestion=None,
    ))
    return {"repo": repo.id, "pr": pr.id, "old": old.id, "new": new.id}


@pytest.fixture()
def seeded():
    """The caller's data, plus a second user's, to prove the two never mix."""
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # one shared in-memory DB across TestClient threads
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)

    with factory() as db:
        user = seed_user(db, github_id=1, username="octo")
        ids = _seed_reviews(db, user, "octo/demo", ("old", "new"))

        stranger = seed_user(db, github_id=2, username="hubot")
        theirs = _seed_reviews(db, stranger, "hubot/private", ("their-old", "their-new"))

        db.commit()
        ids["headers"] = auth_headers(user)
        ids["other_headers"] = auth_headers(stranger)
        ids["their_repo"] = theirs["repo"]
        ids["their_pr"] = theirs["pr"]
        ids["their_review"] = theirs["new"]

    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    yield ids
    app.dependency_overrides.clear()


# ── Authentication ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "method,path",
    [
        ("post", "/reviews/trigger"),
        ("get", "/reviews"),
        ("get", f"/reviews/{uuid.uuid4()}"),
        ("get", f"/prs/{uuid.uuid4()}/review"),
        ("post", f"/reviews/{uuid.uuid4()}/trigger"),
    ],
)
def test_unauthenticated_request_returns_401(seeded, method: str, path: str) -> None:
    response = client.request(
        method.upper(), path, json={"owner": "octo", "repo": "demo", "pr_number": 1}
    )
    assert response.status_code == 401


# ── List ──────────────────────────────────────────────────────────────────────


def test_list_reviews_newest_first_with_join_fields(seeded) -> None:
    body = client.get("/reviews", headers=seeded["headers"]).json()
    assert [r["summary"] for r in body] == ["new", "old"]
    assert body[0]["pr_number"] == 7
    assert body[0]["repo_full_name"] == "octo/demo"


def test_list_reviews_excludes_other_users_reviews(seeded) -> None:
    body = client.get("/reviews", headers=seeded["headers"]).json()

    assert {r["summary"] for r in body} == {"new", "old"}
    assert all(r["repo_full_name"] == "octo/demo" for r in body)


def test_list_reviews_pagination(seeded) -> None:
    headers = seeded["headers"]
    assert len(client.get("/reviews?limit=1", headers=headers).json()) == 1
    assert client.get("/reviews?limit=1&offset=1", headers=headers).json()[0]["summary"] == "old"
    assert client.get("/reviews?limit=0", headers=headers).status_code == 422


def test_list_reviews_omits_raw_diff(seeded) -> None:
    # Diffs are large; the list must stay light.
    body = client.get("/reviews", headers=seeded["headers"]).json()
    assert all("raw_diff" not in item for item in body)


# ── Detail ────────────────────────────────────────────────────────────────────


def test_get_review_detail_with_comments(seeded) -> None:
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["summary"] == "new"
    assert body["verdict"] == "comment"
    assert len(body["comments"]) == 1
    assert body["comments"][0]["file_path"] == "a.py"
    assert body["comments"][0]["category"] == "logic_error"


def test_get_review_detail_names_its_pull_request(seeded) -> None:
    # A deep-linked review has nothing else to identify itself with.
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["pr_number"] == 7
    assert body["repo_full_name"] == "octo/demo"


def test_get_review_detail_exposes_raw_diff(seeded) -> None:
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["raw_diff"] == RAW_DIFF


def test_get_review_404(seeded) -> None:
    assert client.get(f"/reviews/{uuid.uuid4()}", headers=seeded["headers"]).status_code == 404


def test_get_other_users_review_returns_404(seeded) -> None:
    """Indistinguishable from a review that does not exist."""
    response = client.get(f"/reviews/{seeded['their_review']}", headers=seeded["headers"])
    assert response.status_code == 404

    # ...and it is genuinely there for its owner, so 404 is about ownership.
    assert client.get(
        f"/reviews/{seeded['their_review']}", headers=seeded["other_headers"]
    ).status_code == 200


# ── PR review ─────────────────────────────────────────────────────────────────


def test_pr_review_returns_latest(seeded) -> None:
    body = client.get(f"/prs/{seeded['pr']}/review", headers=seeded["headers"]).json()
    assert body["id"] == str(seeded["new"])
    assert client.get(
        f"/prs/{uuid.uuid4()}/review", headers=seeded["headers"]
    ).status_code == 404


def test_pr_review_for_other_users_pr_returns_404(seeded) -> None:
    response = client.get(f"/prs/{seeded['their_pr']}/review", headers=seeded["headers"])
    assert response.status_code == 404


# ── Trigger ───────────────────────────────────────────────────────────────────


@pytest.fixture()
def enqueued(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, int]]:
    calls: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        reviews_api.review_worker,
        "enqueue_review",
        lambda owner, repo, pr: calls.append((owner, repo, pr)),
    )
    return calls


def test_rereview_trigger_enqueues_for_existing_review(seeded, enqueued) -> None:
    response = client.post(f"/reviews/{seeded['old']}/trigger", headers=seeded["headers"])
    assert response.status_code == 202
    assert response.json() == {"status": "queued", "repo": "octo/demo", "pr_number": 7}
    assert enqueued == [("octo", "demo", 7)]
    assert client.post(
        f"/reviews/{uuid.uuid4()}/trigger", headers=seeded["headers"]
    ).status_code == 404


def test_cannot_rereview_another_users_review(seeded, enqueued) -> None:
    response = client.post(
        f"/reviews/{seeded['their_review']}/trigger", headers=seeded["headers"]
    )
    assert response.status_code == 404
    assert enqueued == []  # and no work was queued on their behalf


def test_manual_trigger_requires_a_connected_repo(seeded, enqueued) -> None:
    """Authentication alone is not enough — this route names a repo by string.

    Without an ownership check any logged-in user could spend tokens reviewing
    an arbitrary repository.
    """
    response = client.post(
        "/reviews/trigger",
        json={"owner": "hubot", "repo": "private", "pr_number": 3},
        headers=seeded["headers"],
    )
    assert response.status_code == 404
    assert enqueued == []


def test_manual_trigger_works_for_own_repo(seeded, enqueued) -> None:
    response = client.post(
        "/reviews/trigger",
        json={"owner": "octo", "repo": "demo", "pr_number": 12},
        headers=seeded["headers"],
    )
    assert response.status_code == 202
    assert enqueued == [("octo", "demo", 12)]


# ── CORS ──────────────────────────────────────────────────────────────────────


def test_cors_headers_echoed_for_dev_origin(seeded) -> None:
    origin = "http://localhost:5173"
    response = client.get("/reviews", headers={"Origin": origin, **seeded["headers"]})
    assert response.headers["access-control-allow-origin"] == origin
