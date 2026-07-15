import uuid

import chromadb
import pytest
from conftest import FakeGitHub, shared_chroma_client
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
from app.services.github_service import RepositoryMeta

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
def indexed(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []
    monkeypatch.setattr(
        repos_api.index_worker, "enqueue_index", lambda repo_id: calls.append(str(repo_id))
    )
    return calls


@pytest.fixture()
def fake_github(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(repos_api, "GitHubClient", lambda: FakeGitHub(repo_meta=REPO_META))


def test_connect_repo_creates_row_and_queues_index(session_factory, indexed, fake_github) -> None:
    response = client.post("/repos", json={"full_name": "octo/demo"})
    assert response.status_code == 201
    body = response.json()
    assert body["full_name"] == "octo/demo"
    assert body["default_branch"] == "main"

    with session_factory() as db:
        repo = db.scalars(select(Repository)).one()
        assert repo.github_repo_id == 4242
    assert indexed == [body["id"]]


def test_connect_repo_is_idempotent(session_factory, indexed, fake_github) -> None:
    first = client.post("/repos", json={"full_name": "octo/demo"}).json()
    second = client.post("/repos", json={"full_name": "octo/demo"}).json()
    assert first["id"] == second["id"]
    with session_factory() as db:
        assert len(db.scalars(select(Repository)).all()) == 1
    assert len(indexed) == 2  # reconnect re-queues indexing


def test_connect_repo_validates_full_name(session_factory) -> None:
    assert client.post("/repos", json={"full_name": "not-a-repo"}).status_code == 422


def test_list_and_status(session_factory, indexed, fake_github) -> None:
    created = client.post("/repos", json={"full_name": "octo/demo"}).json()

    listed = client.get("/repos").json()
    assert [r["id"] for r in listed] == [created["id"]]

    status = client.get(f"/repos/{created['id']}/status").json()
    assert status == {
        "id": created["id"],
        "full_name": "octo/demo",
        "status": "not_indexed",
        "indexed_at": None,
        "chunk_count": 0,
    }


def test_status_unknown_repo_404(session_factory) -> None:
    assert client.get(f"/repos/{uuid.uuid4()}/status").status_code == 404


def test_trigger_index_endpoint(session_factory, indexed, fake_github) -> None:
    created = client.post("/repos", json={"full_name": "octo/demo"}).json()
    indexed.clear()
    response = client.post(f"/repos/{created['id']}/index")
    assert response.status_code == 202
    assert indexed == [created["id"]]
    assert client.post(f"/repos/{uuid.uuid4()}/index").status_code == 404


def test_disconnect_repo(session_factory, indexed, fake_github, monkeypatch) -> None:
    monkeypatch.setattr(repos_api, "get_chroma_client", shared_chroma_client)
    created = client.post("/repos", json={"full_name": "octo/demo"}).json()

    assert client.delete(f"/repos/{created['id']}").status_code == 204
    with session_factory() as db:
        assert db.scalars(select(Repository)).all() == []
        # system user survives repo deletion
        assert db.scalars(select(User)).one().username == "system"
    assert client.delete(f"/repos/{created['id']}").status_code == 404
