import uuid

import pytest
from conftest import FakeGitHub, auth_headers, seed_user, shared_chroma_client
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api import repos as repos_api
from app.database import Base, get_db
from app.main import app
from app.models.repository import Repository
from app.models.user import User
from app.services.github_service import GitHubAuthError, RepositoryMeta

client = TestClient(app)

REPO_META = RepositoryMeta(id=4242, full_name="octo/demo", default_branch="main")


@pytest.fixture()
def session_factory():
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # one shared in-memory DB across TestClient threads
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)

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
def caller(session_factory) -> dict[str, str]:
    """The authenticated user every request in this module acts as."""
    with session_factory() as db:
        user = seed_user(db, github_id=1, username="octo")
        db.commit()
        return auth_headers(user)


@pytest.fixture()
def other(session_factory) -> dict[str, str]:
    """A second account, used to prove requests cannot cross between users."""
    with session_factory() as db:
        user = seed_user(db, github_id=2, username="hubot")
        db.commit()
        return auth_headers(user)


@pytest.fixture()
def indexed(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []
    monkeypatch.setattr(
        repos_api.index_worker, "enqueue_index", lambda repo_id: calls.append(str(repo_id))
    )
    return calls


@pytest.fixture()
def fake_github(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        repos_api,
        "GitHubClient",
        # Records the token the route constructed it with (AUTH-5).
        lambda token=None: FakeGitHub(repo_meta=REPO_META, token=token),
    )


def _connect(headers: dict[str, str], full_name: str = "octo/demo") -> dict:
    return client.post("/repos", json={"full_name": full_name}, headers=headers).json()


# ── Authentication ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "method,path",
    [
        ("post", "/repos"),
        ("get", "/repos"),
        ("delete", f"/repos/{uuid.uuid4()}"),
        ("post", f"/repos/{uuid.uuid4()}/index"),
        ("get", f"/repos/{uuid.uuid4()}/status"),
    ],
)
def test_unauthenticated_request_returns_401(session_factory, method: str, path: str) -> None:
    # client.request rather than client.get/.delete: the shorthand helpers for
    # bodyless verbs do not accept json=.
    response = client.request(method.upper(), path, json={"full_name": "octo/demo"})
    assert response.status_code == 401


# ── Connect ───────────────────────────────────────────────────────────────────


def test_connect_repo_creates_row_and_queues_index(
    session_factory, caller, indexed, fake_github
) -> None:
    response = client.post("/repos", json={"full_name": "octo/demo"}, headers=caller)
    assert response.status_code == 201
    body = response.json()
    assert body["full_name"] == "octo/demo"
    assert body["default_branch"] == "main"

    with session_factory() as db:
        repo = db.scalars(select(Repository)).one()
        assert repo.github_repo_id == 4242
        # Owned by the caller, not by a phantom system user.
        owner = db.scalars(select(User).where(User.github_id == 1)).one()
        assert repo.user_id == owner.id
    assert indexed == [body["id"]]


def test_connect_repo_is_idempotent(session_factory, caller, indexed, fake_github) -> None:
    first = _connect(caller)
    second = _connect(caller)
    assert first["id"] == second["id"]
    with session_factory() as db:
        assert len(db.scalars(select(Repository)).all()) == 1
    assert len(indexed) == 2  # reconnect re-queues indexing


def test_connect_repo_does_not_hijack_another_users_row(
    session_factory, caller, other, indexed, fake_github
) -> None:
    """Two users connecting the same repository must get separate rows.

    full_name has no unique constraint, so an unscoped existence check would
    hand the second caller the first user's row and re-queue indexing on it.
    """
    theirs = _connect(other)
    mine = _connect(caller)

    assert mine["id"] != theirs["id"]
    with session_factory() as db:
        rows = db.scalars(select(Repository).where(Repository.full_name == "octo/demo")).all()
        assert len(rows) == 2
        assert len({r.user_id for r in rows}) == 2


def test_connect_repo_validates_full_name(session_factory, caller) -> None:
    response = client.post("/repos", json={"full_name": "not-a-repo"}, headers=caller)
    assert response.status_code == 422


# ── List / status ─────────────────────────────────────────────────────────────


def test_list_and_status(session_factory, caller, indexed, fake_github) -> None:
    created = _connect(caller)

    listed = client.get("/repos", headers=caller).json()
    assert [r["id"] for r in listed] == [created["id"]]

    status = client.get(f"/repos/{created['id']}/status", headers=caller).json()
    assert status == {
        "id": created["id"],
        "full_name": "octo/demo",
        "status": "not_indexed",
        "indexed_at": None,
        "chunk_count": 0,
    }


def test_list_repos_excludes_other_users_repos(
    session_factory, caller, other, indexed, fake_github
) -> None:
    _connect(other)
    mine = _connect(caller, "octo/mine")

    listed = client.get("/repos", headers=caller).json()

    assert [r["id"] for r in listed] == [mine["id"]]


def test_get_other_users_repo_returns_404(
    session_factory, caller, other, indexed, fake_github
) -> None:
    """404 rather than 403 — a 403 would confirm the repository exists."""
    theirs = _connect(other)

    assert client.get(f"/repos/{theirs['id']}/status", headers=caller).status_code == 404
    assert client.post(f"/repos/{theirs['id']}/index", headers=caller).status_code == 404


def test_cannot_delete_another_users_repo(
    session_factory, caller, other, indexed, fake_github, monkeypatch
) -> None:
    monkeypatch.setattr(repos_api, "get_chroma_client", shared_chroma_client)
    theirs = _connect(other)

    assert client.delete(f"/repos/{theirs['id']}", headers=caller).status_code == 404
    with session_factory() as db:
        assert len(db.scalars(select(Repository)).all()) == 1  # survived


def test_status_unknown_repo_404(session_factory, caller) -> None:
    assert client.get(f"/repos/{uuid.uuid4()}/status", headers=caller).status_code == 404


# ── Index / disconnect ────────────────────────────────────────────────────────


def test_trigger_index_endpoint(session_factory, caller, indexed, fake_github) -> None:
    created = _connect(caller)
    indexed.clear()

    response = client.post(f"/repos/{created['id']}/index", headers=caller)
    assert response.status_code == 202
    assert indexed == [created["id"]]
    assert client.post(f"/repos/{uuid.uuid4()}/index", headers=caller).status_code == 404


def test_disconnect_repo(session_factory, caller, indexed, fake_github, monkeypatch) -> None:
    monkeypatch.setattr(repos_api, "get_chroma_client", shared_chroma_client)
    created = _connect(caller)

    assert client.delete(f"/repos/{created['id']}", headers=caller).status_code == 204
    with session_factory() as db:
        assert db.scalars(select(Repository)).all() == []
        # The owning user survives deletion of their repository.
        assert db.scalars(select(User).where(User.github_id == 1)).one().username == "octo"
    assert client.delete(f"/repos/{created['id']}", headers=caller).status_code == 404


# ── Feedback routes (same namespace, so the same rule) ────────────────────────


def test_feedback_routes_require_auth(session_factory, caller) -> None:
    """They sit under /reviews and /comments, so they follow the same rule.

    An open route beside authenticated siblings becomes a leak the moment
    somebody wires it to the database — which EVAL-1 (#190) then did.

    The authenticated half asserts "not 401" rather than a specific code: the
    ids are random, so the POST is now a legitimate 404 (the ownership walk
    finds no such comment). What this test is about is that the token is
    *required*, not what a real request returns — ``test_api_feedback.py``
    covers that.
    """
    review_id, comment_id = uuid.uuid4(), uuid.uuid4()

    assert client.get(f"/reviews/{review_id}/eval").status_code == 401
    assert client.post(f"/comments/{comment_id}/feedback", json={"rating": 1}).status_code == 401

    assert client.get(f"/reviews/{review_id}/eval", headers=caller).status_code != 401
    assert client.post(
        f"/comments/{comment_id}/feedback", json={"rating": 1}, headers=caller
    ).status_code == 404


# ── Acting identity (AUTH-5) ──────────────────────────────────────────────────


def test_connect_repo_uses_callers_token(session_factory, caller, indexed, monkeypatch) -> None:
    """The GitHub call is made as the caller, not as the server-side PAT."""
    with session_factory() as db:
        user = db.scalars(select(User).where(User.github_id == 1)).one()
        user.github_access_token = "gho_caller"
        db.commit()

    built: list[FakeGitHub] = []

    def factory(token=None):
        gh = FakeGitHub(repo_meta=REPO_META, token=token)
        built.append(gh)
        return gh

    monkeypatch.setattr(repos_api, "GitHubClient", factory)
    client.post("/repos", json={"full_name": "octo/demo"}, headers=caller)

    assert [gh.token for gh in built] == ["gho_caller"]


def test_connect_repo_falls_back_to_pat_when_user_has_no_token(
    session_factory, caller, indexed, monkeypatch
) -> None:
    # A user who predates AUTH-5 has no stored token; get_github_token then
    # falls back to settings.github_token, so the behaviour must not regress.
    built: list[FakeGitHub] = []

    def factory(token=None):
        gh = FakeGitHub(repo_meta=REPO_META, token=token)
        built.append(gh)
        return gh

    monkeypatch.setattr(repos_api, "GitHubClient", factory)
    client.post("/repos", json={"full_name": "octo/demo"}, headers=caller)

    assert [gh.token for gh in built] == [None]


def test_revoked_token_returns_503_not_500(
    session_factory, caller, indexed, monkeypatch
) -> None:
    """Revoking access on GitHub is normal, and must read as a clear error."""
    def factory(token=None):
        raise GitHubAuthError("GitHub rejected the credentials. Reconnect your account.")

    monkeypatch.setattr(repos_api, "GitHubClient", factory)
    response = client.post("/repos", json={"full_name": "octo/demo"}, headers=caller)

    assert response.status_code == 503
    assert "reconnect" in response.json()["detail"].lower()
