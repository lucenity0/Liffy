import json
import uuid
from datetime import datetime, timezone

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
from app.config import apply_overrides, settings
from app.database import Base, get_db
from app.main import app
from app.models.repository import Repository
from app.models.review import Review
from app.models.setting import Setting
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
    # The task dict enumerates its fields, so a counter added to IndexResult
    # and forgotten here never reaches a caller.
    assert result["files_failed"] == 0


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
    # `received_at` defaulted, and recorded: a manual trigger has no webhook
    # receipt, and the None is asserted rather than ignored — §8.1's figure
    # must stay NULL here rather than borrow `duration_ms`.
    calls: list[tuple[str, str, int, str | None]] = []
    monkeypatch.setattr(
        reviews_api.review_worker,
        "enqueue_review",
        lambda owner, repo, pr, received_at=None: calls.append((owner, repo, pr, received_at)),
    )
    response = client.post(
        "/reviews/trigger",
        json={"owner": "octo", "repo": "demo", "pr_number": 12},
        headers=api_db,
    )
    assert response.status_code == 202
    assert response.json() == {"status": "queued", "repo": "octo/demo", "pr_number": 12}
    assert calls == [("octo", "demo", 12, None)]


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


# ── §8.1 receipt threading (METRIC-2) ────────────────────────────────────────


def _review_deps(monkeypatch) -> None:
    monkeypatch.setattr(
        review_worker,
        "GitHubClient",
        lambda token=None: FakeGitHub(pr_meta=META, pr_diff=DIFF, token=token),
    )
    monkeypatch.setattr(review_worker, "get_chroma_client", shared_chroma_client)
    monkeypatch.setattr(review_worker, "get_embedding_provider", DeterministicEmbeddings)
    monkeypatch.setattr(review_worker, "get_llm", lambda: FakeLLM([PAYLOAD]))


def test_task_accepts_received_at(session_factory, monkeypatch) -> None:
    """The only test that walks the real ISO-string parse in production code.

    ``run_review`` takes a ``datetime``; Celery delivers a string. The
    conversion happens here in the task, and nothing else exercises it.
    """
    _connect(session_factory)
    _review_deps(monkeypatch)

    result = review_worker.review_pr_task(
        "octo", "demo", 5, datetime.now(timezone.utc).isoformat()
    )

    assert result["status"] == "completed"
    with session_factory() as db:
        review = db.scalars(select(Review)).one()
        assert review.queued_at is not None
        assert review.total_ms is not None


def test_task_without_received_at_still_runs(session_factory, monkeypatch) -> None:
    """The backwards-compatible default.

    A message enqueued by the old three-argument code must drain rather than
    raise ``TypeError`` on a rolling deploy — and it must record NULL rather
    than substituting the pipeline duration.
    """
    _connect(session_factory)
    _review_deps(monkeypatch)

    result = review_worker.review_pr_task("octo", "demo", 5)

    assert result["status"] == "completed"
    with session_factory() as db:
        review = db.scalars(select(Review)).one()
        assert review.total_ms is None
        assert review.queued_at is None


def test_task_with_malformed_received_at_still_completes(session_factory, monkeypatch) -> None:
    """A metric is not worth failing a review over.

    An unparseable stamp costs one row of analytics; raising would cost the
    review itself, and the review is the product.
    """
    _connect(session_factory)
    _review_deps(monkeypatch)

    result = review_worker.review_pr_task("octo", "demo", 5, "not-a-timestamp")

    assert result["status"] == "completed"
    with session_factory() as db:
        assert db.scalars(select(Review)).one().total_ms is None


def test_non_string_received_at_still_completes(session_factory, monkeypatch) -> None:
    """The broker boundary is untrusted in type, not only in format.

    ``fromisoformat`` raises ``TypeError`` — not ``ValueError`` — for a
    non-string, and the parse sits in ``run_review``'s argument list, so
    catching only ``ValueError`` lets it escape the task before a review row is
    ever created. Nothing enforces the ``str`` annotation across Celery: a
    caller passing an int, or a replayed message, delivers an int.
    """
    _connect(session_factory)
    _review_deps(monkeypatch)

    result = review_worker.review_pr_task("octo", "demo", 5, 1753900000)

    assert result["status"] == "completed"
    with session_factory() as db:
        assert db.scalars(select(Review)).one().total_ms is None


def test_parse_received_at_never_raises() -> None:
    """The contract, pinned directly — the helper's whole job is not to throw."""
    for value in (None, "", "garbage", "2026-13-45T99:99:99", 1753900000, 17539.0, ["x"], {}):
        assert review_worker._parse_received_at(value) is None


def test_naive_received_at_is_refused_rather_than_assumed_utc(
    session_factory, monkeypatch
) -> None:
    """Assuming UTC would record the API host's offset as queue wait.

    On a machine at UTC+05:30 that is a 5.5-hour latency figure that parses,
    stores and renders perfectly — far worse than no number.
    """
    _connect(session_factory)
    _review_deps(monkeypatch)

    review_worker.review_pr_task("octo", "demo", 5, "2026-07-30T12:00:00")

    with session_factory() as db:
        assert db.scalars(select(Review)).one().total_ms is None


def test_enqueue_passes_a_json_serialisable_received_at(monkeypatch) -> None:
    """A ``datetime`` would fail at ``.delay()``, not at execution.

    ``celery_app`` sets ``task_serializer="json"``, so the broker rejects it
    before the task ever runs and the traceback points at infrastructure.
    """
    captured: list[tuple] = []
    monkeypatch.setattr(
        review_worker.review_pr_task, "delay", lambda *args: captured.append(args)
    )

    review_worker.enqueue_review("octo", "demo", 7, datetime.now(timezone.utc).isoformat())

    assert len(captured) == 1
    json.dumps(captured[0])  # raises TypeError on a datetime


def test_review_task_picks_up_a_settings_override(session_factory, monkeypatch) -> None:
    """The cross-process claim, tested at the seam where it is made.

    The worker runs in its own process, so invalidating the API's override
    store on write does nothing for it. This asserts the other half of the
    answer: the task reloads overrides from the database before doing any
    work, so a setting changed in the UI applies to the *next* review rather
    than after a restart.

    `post_reviews_to_github` is the one worth asserting on. It defaults to
    False, and `run_review` reads it deep inside the pipeline — so if the
    refresh were missing, or placed after `get_llm()`, this review would
    silently not post and the failure would look like a GitHub problem.
    """
    _connect(session_factory)
    monkeypatch.setattr(
        review_worker,
        "GitHubClient",
        lambda token=None: FakeGitHub(pr_meta=META, pr_diff=DIFF, token=token),
    )
    monkeypatch.setattr(review_worker, "get_chroma_client", shared_chroma_client)
    monkeypatch.setattr(review_worker, "get_embedding_provider", DeterministicEmbeddings)
    monkeypatch.setattr(review_worker, "get_llm", lambda: FakeLLM([PAYLOAD]))

    seen: list[bool] = []
    monkeypatch.setattr(
        review_worker, "run_review",
        lambda db, *a, **kw: seen.append(settings.post_reviews_to_github) or Review(
            id=uuid.uuid4(), pr_id=uuid.uuid4(), status="completed"
        ),
    )

    # Written straight to the table, which is what the API process leaves
    # behind — the worker never sees the PATCH itself.
    with session_factory() as db:
        db.add(Setting(key="post_reviews_to_github", value="true"))
        db.commit()

    try:
        review_worker.review_pr_task("octo", "demo", 5)
        assert seen == [True]
    finally:
        # Process-global store; leaving it set would turn posting on for every
        # test that runs after this one.
        apply_overrides({})
