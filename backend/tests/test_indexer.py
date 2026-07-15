import hashlib

import chromadb
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

import app.models  # noqa: F401
from app.database import Base
from app.models.repo_embedding import RepoEmbedding
from app.models.repository import Repository
from app.models.user import User
from app.services.chunker import chunk_source
from app.services.indexer import index_repository
from app.services.rag_service import get_repo_collection


from conftest import DeterministicEmbeddings as FakeEmbeddings
from conftest import shared_chroma_client
from conftest import FakeGitHub


FILES = {
    "app/a.py": "def alpha():\n    return 1\n",
    "app/b.py": "import os\n\n\ndef beta():\n    return os.name\n",
    "README.md": "# Demo\nSome text.\n",
}


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


@pytest.fixture()
def repo(db: Session) -> Repository:
    user = User(github_id=1, username="octo")
    db.add(user)
    db.flush()
    repository = Repository(user_id=user.id, github_repo_id=99, full_name="octo/demo")
    db.add(repository)
    db.commit()
    return repository


def _run(db, repo, files, embedder=None, client=None):
    client = client or shared_chroma_client()
    embedder = embedder or FakeEmbeddings()
    result = index_repository(
        db, repo, gh=FakeGitHub(files), chroma_client=client, embedder=embedder
    )
    return result, client, embedder


def test_first_run_populates_collection_and_sync_log(db, repo) -> None:
    result, client, embedder = _run(db, repo, FILES)

    assert result.files_seen == 3
    assert result.chunks_added > 0
    assert result.chunks_skipped == 0 and result.chunks_deleted == 0

    collection = get_repo_collection(client, repo.id)
    assert collection.count() == result.chunks_added
    rows = db.scalars(select(RepoEmbedding).where(RepoEmbedding.repo_id == repo.id)).all()
    assert len(rows) == result.chunks_added
    assert repo.indexed_at is not None
    # metadata is queryable by file
    got = collection.get(where={"file_path": "app/a.py"})
    assert len(got["ids"]) >= 1


def test_rerun_is_idempotent(db, repo) -> None:
    _, client, _ = _run(db, repo, FILES)
    result2, _, embedder2 = _run(db, repo, FILES, client=client)

    assert result2.chunks_added == 0
    assert result2.chunks_deleted == 0
    assert result2.chunks_skipped > 0
    assert embedder2.calls == []  # nothing embedded on the second run


def test_changed_file_reembeds_only_its_chunks(db, repo) -> None:
    _, client, _ = _run(db, repo, FILES)

    changed = dict(FILES)
    changed["app/a.py"] = "def alpha():\n    return 2\n"
    result, _, embedder = _run(db, repo, changed, client=client)

    assert result.chunks_added == 1  # only a.py's single chunk
    assert sum(embedder.calls) == 1
    row = db.scalars(
        select(RepoEmbedding).where(RepoEmbedding.file_path == "app/a.py")
    ).one()
    assert row.content_hash == chunk_source("app/a.py", changed["app/a.py"])[0].content_hash


def test_removed_file_cleans_vectors_and_rows(db, repo) -> None:
    _, client, _ = _run(db, repo, FILES)
    before = get_repo_collection(client, repo.id).count()

    remaining = {k: v for k, v in FILES.items() if k != "app/b.py"}
    result, _, _ = _run(db, repo, remaining, client=client)

    assert result.chunks_deleted > 0
    assert get_repo_collection(client, repo.id).count() == before - result.chunks_deleted
    paths = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    assert "app/b.py" not in paths
