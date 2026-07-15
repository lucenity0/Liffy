import json
import uuid

import chromadb
import pytest
from conftest import DeterministicEmbeddings, FakeGitHub, FakeLLM, shared_chroma_client
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

import app.models  # noqa: F401
from app.api import reviews as reviews_api
from app.database import Base
from app.main import app
from app.models.repository import Repository
from app.models.review import Review
from app.models.user import User
from app.services.github_service import PullRequestMeta
from app.workers import index_worker, review_worker

client = TestClient(app)

DIFF = """\
diff --git a/app/util.py b/app/util.py
--- a/app/util.py
+++ b/app/util.py
@@ -1,2 +1,3 @@
 def helper():
+    return 2
 pass
"""

META = PullRequestMeta(
    number=5, title="T", author="a", base_branch="main", head_branch="b", head_sha="s", state="open"
)

PAYLOAD = json.dumps({"summary": "ok", "verdict": "approve", "comments": []})


@pytest.fixture()
def session_factory(monkeypatch: pytest.MonkeyPatch):
    engine = create_engine(
        "sqlite://", future=True, connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setattr(review_worker, "SessionLocal", factory)
    monkeypatch.setattr(index_worker, "SessionLocal", factory)
    return factory


def test_review_task_writes_review_row(session_factory, monkeypatch) -> None:
    monkeypatch.setattr(review_worker, "GitHubClient", lambda: FakeGitHub(pr_meta=META, pr_diff=DIFF))
    monkeypatch.setattr(review_worker, "get_chroma_client", shared_chroma_client)
    monkeypatch.setattr(review_worker, "get_embedding_provider", DeterministicEmbeddings)
    monkeypatch.setattr(review_worker, "OpenAIReviewLLM", lambda: FakeLLM([PAYLOAD]))

    result = review_worker.review_pr_task("octo", "demo", 5)

    assert result["status"] == "completed"
    with session_factory() as db:
        review = db.scalars(select(Review)).one()
        assert str(review.id) == result["review_id"]
        assert review.verdict == "approve"


def test_index_task_indexes_repo(session_factory, monkeypatch) -> None:
    with session_factory() as db:
        user = User(github_id=1, username="octo")
        db.add(user)
        db.flush()
        repo = Repository(user_id=user.id, github_repo_id=9, full_name="octo/demo")
        db.add(repo)
        db.commit()
        repo_id = repo.id

    monkeypatch.setattr(
        index_worker, "GitHubClient", lambda: FakeGitHub(files={"a.py": "def f():\n    return 1\n"})
    )
    monkeypatch.setattr(index_worker, "get_chroma_client", shared_chroma_client)
    monkeypatch.setattr(index_worker, "get_embedding_provider", DeterministicEmbeddings)

    result = index_worker.index_repo_task(str(repo_id))
    assert result["status"] == "ok"
    assert result["files_seen"] == 1
    assert result["chunks_added"] >= 1


def test_index_task_missing_repo(session_factory) -> None:
    result = index_worker.index_repo_task(str(uuid.uuid4()))
    assert result["status"] == "missing"


def test_manual_trigger_endpoint_enqueues(monkeypatch) -> None:
    calls: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        reviews_api.review_worker,
        "enqueue_review",
        lambda owner, repo, pr: calls.append((owner, repo, pr)),
    )
    response = client.post(
        "/reviews/trigger", json={"owner": "octo", "repo": "demo", "pr_number": 12}
    )
    assert response.status_code == 202
    assert response.json() == {"status": "queued", "repo": "octo/demo", "pr_number": 12}
    assert calls == [("octo", "demo", 12)]


def test_manual_trigger_validates_body() -> None:
    response = client.post("/reviews/trigger", json={"owner": "octo", "repo": "demo", "pr_number": 0})
    assert response.status_code == 422
