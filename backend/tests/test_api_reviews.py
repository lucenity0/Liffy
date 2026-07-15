import uuid
from datetime import datetime, timedelta, timezone

import pytest
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


@pytest.fixture()
def seeded():
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # one shared in-memory DB across TestClient threads
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)

    with factory() as db:
        user = User(github_id=1, username="octo")
        db.add(user)
        db.flush()
        repo = Repository(user_id=user.id, github_repo_id=9, full_name="octo/demo")
        db.add(repo)
        db.flush()
        pr = PullRequest(
            repo_id=repo.id, github_pr_number=7, title="Fix", author="octo",
            base_branch="main", head_branch="fix", status="open",
        )
        db.add(pr)
        db.flush()
        old = Review(pr_id=pr.id, status="completed", summary="old", verdict="approve",
                     model_used="m", tokens_used=10, created_at=T0)
        new = Review(pr_id=pr.id, status="completed", summary="new", verdict="comment",
                     model_used="m", tokens_used=20, created_at=T0 + timedelta(hours=1))
        db.add_all([old, new])
        db.flush()
        db.add(ReviewComment(
            review_id=new.id, file_path="a.py", line_start=1, line_end=2,
            category="logic_error", severity="warning", comment_text="Bug.", suggestion=None,
        ))
        db.commit()
        ids = {"repo": repo.id, "pr": pr.id, "old": old.id, "new": new.id}

    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    yield ids
    app.dependency_overrides.clear()


def test_list_reviews_newest_first_with_join_fields(seeded) -> None:
    body = client.get("/reviews").json()
    assert [r["summary"] for r in body] == ["new", "old"]
    assert body[0]["pr_number"] == 7
    assert body[0]["repo_full_name"] == "octo/demo"


def test_list_reviews_pagination(seeded) -> None:
    assert len(client.get("/reviews?limit=1").json()) == 1
    assert client.get("/reviews?limit=1&offset=1").json()[0]["summary"] == "old"
    assert client.get("/reviews?limit=0").status_code == 422


def test_get_review_detail_with_comments(seeded) -> None:
    body = client.get(f"/reviews/{seeded['new']}").json()
    assert body["summary"] == "new"
    assert body["verdict"] == "comment"
    assert len(body["comments"]) == 1
    assert body["comments"][0]["file_path"] == "a.py"
    assert body["comments"][0]["category"] == "logic_error"


def test_get_review_404(seeded) -> None:
    assert client.get(f"/reviews/{uuid.uuid4()}").status_code == 404


def test_pr_review_returns_latest(seeded) -> None:
    body = client.get(f"/prs/{seeded['pr']}/review").json()
    assert body["id"] == str(seeded["new"])
    assert client.get(f"/prs/{uuid.uuid4()}/review").status_code == 404


def test_rereview_trigger_enqueues_for_existing_review(seeded, monkeypatch) -> None:
    calls: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        reviews_api.review_worker,
        "enqueue_review",
        lambda owner, repo, pr: calls.append((owner, repo, pr)),
    )
    response = client.post(f"/reviews/{seeded['old']}/trigger")
    assert response.status_code == 202
    assert response.json() == {"status": "queued", "repo": "octo/demo", "pr_number": 7}
    assert calls == [("octo", "demo", 7)]
    assert client.post(f"/reviews/{uuid.uuid4()}/trigger").status_code == 404
