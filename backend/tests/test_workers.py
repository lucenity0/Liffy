import json
import uuid

import chromadb
import pytest
from conftest import (
    DeterministicEmbeddings,
    FakeGitHub,
    FakeLLM,
    auth_headers,
    shared_chroma_client,
)
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api import reviews as reviews_api
from app.database import Base, get_db
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
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        # Needed now that these tests also drive the API: TestClient runs the
        # app on another thread, and without a shared connection that thread
        # would see its own empty in-memory database.
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setattr(review_worker, "SessionLocal", factory)
    monkeypatch.setattr(index_worker, "SessionLocal", factory)
    return factory


def _connect(factory, full_name: str = "octo/demo") -> None:
    """Connect the repo the task will review; reviews need an owner now."""
    with factory() as db:
        user = User(github_id=1, username="octo")
        db.add(user)
        db.flush()
        db.add(Repository(user_id=user.id, github_repo_id=9, full_name=full_name))
        db.commit()


def test_review_task_writes_review_row(session_factory, monkeypatch) -> None:
    _connect(session_factory)
    monkeypatch.setattr(
        review_worker,
        "GitHubClient",
        lambda token=None: FakeGitHub(pr_meta=META, pr_diff=DIFF, token=token),
    )
    monkeypatch.setattr(review_worker, "get_chroma_client", shared_chroma_client)
    monkeypatch.setattr(review_worker, "get_embedding_provider", DeterministicEmbeddings)
    monkeypatch.setattr(review_worker, "get_llm", lambda: FakeLLM([PAYLOAD]))

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
        index_worker,
        "GitHubClient",
        lambda token=None: FakeGitHub(files={"a.py": "def f():\n    return 1\n"}, token=token),
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


@pytest.fixture()
def api_db(session_factory):
    """Point the API at the worker's database and return the caller's headers."""
    _connect(session_factory)

    def override():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    with session_factory() as db:
        headers = auth_headers(db.scalars(select(User)).one())
    yield headers
    app.dependency_overrides.clear()


def test_manual_trigger_endpoint_enqueues(api_db, monkeypatch) -> None:
    calls: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        reviews_api.review_worker,
        "enqueue_review",
        lambda owner, repo, pr: calls.append((owner, repo, pr)),
    )
    response = client.post(
        "/reviews/trigger",
        json={"owner": "octo", "repo": "demo", "pr_number": 12},
        headers=api_db,
    )
    assert response.status_code == 202
    assert response.json() == {"status": "queued", "repo": "octo/demo", "pr_number": 12}
    assert calls == [("octo", "demo", 12)]


def test_manual_trigger_validates_body(api_db) -> None:
    response = client.post(
        "/reviews/trigger",
        json={"owner": "octo", "repo": "demo", "pr_number": 0},
        headers=api_db,
    )
    assert response.status_code == 422


def test_review_task_ignores_unconnected_repo(session_factory, monkeypatch) -> None:
    """The repo was disconnected between enqueue and execution.

    Not worth retrying — there is nobody left to own the result.
    """
    monkeypatch.setattr(
        review_worker,
        "GitHubClient",
        lambda token=None: FakeGitHub(pr_meta=META, pr_diff=DIFF, token=token),
    )
    monkeypatch.setattr(review_worker, "get_chroma_client", shared_chroma_client)
    monkeypatch.setattr(review_worker, "get_embedding_provider", DeterministicEmbeddings)
    monkeypatch.setattr(review_worker, "get_llm", lambda: FakeLLM([PAYLOAD]))

    result = review_worker.review_pr_task("stranger", "unknown", 5)

    assert result["status"] == "ignored"
    with session_factory() as db:
        assert db.scalars(select(Review)).all() == []


def test_worker_resolves_token_from_repo_owner(session_factory, monkeypatch) -> None:
    """Workers have no request context, so the token comes from the owner.

    Resolving from the owner rather than the triggering user is also what
    stops user B's re-review from failing on a repo only user A can reach.
    """
    with session_factory() as db:
        user = User(github_id=1, username="octo", github_access_token="gho_owner")
        db.add(user)
        db.flush()
        db.add(Repository(user_id=user.id, github_repo_id=9, full_name="octo/demo"))
        db.commit()

    built: list[FakeGitHub] = []

    def factory(token=None):
        gh = FakeGitHub(pr_meta=META, pr_diff=DIFF, token=token)
        built.append(gh)
        return gh

    monkeypatch.setattr(review_worker, "GitHubClient", factory)
    monkeypatch.setattr(review_worker, "get_chroma_client", shared_chroma_client)
    monkeypatch.setattr(review_worker, "get_embedding_provider", DeterministicEmbeddings)
    monkeypatch.setattr(review_worker, "get_llm", lambda: FakeLLM([PAYLOAD]))

    review_worker.review_pr_task("octo", "demo", 5)

    assert [gh.token for gh in built] == ["gho_owner"]


def test_index_worker_resolves_token_from_repo_owner(session_factory, monkeypatch) -> None:
    with session_factory() as db:
        user = User(github_id=1, username="octo", github_access_token="gho_owner")
        db.add(user)
        db.flush()
        repo = Repository(user_id=user.id, github_repo_id=9, full_name="octo/demo")
        db.add(repo)
        db.commit()
        repo_id = repo.id

    built: list[FakeGitHub] = []

    def factory(token=None):
        gh = FakeGitHub(files={"a.py": "def f():\n    return 1\n"}, token=token)
        built.append(gh)
        return gh

    monkeypatch.setattr(index_worker, "GitHubClient", factory)
    monkeypatch.setattr(index_worker, "get_chroma_client", shared_chroma_client)
    monkeypatch.setattr(index_worker, "get_embedding_provider", DeterministicEmbeddings)

    index_worker.index_repo_task(str(repo_id))

    assert [gh.token for gh in built] == ["gho_owner"]
