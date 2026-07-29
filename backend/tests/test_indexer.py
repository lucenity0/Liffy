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
from app.services.github_service import _is_indexable
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


def test_oversized_file_keeps_existing_chunks(db, repo, monkeypatch) -> None:
    # Regression: a file that grows past MAX_FILE_BYTES on re-index must keep
    # its already-indexed chunks, not be purged by stale-cleanup.
    _, client, _ = _run(db, repo, FILES)
    before = get_repo_collection(client, repo.id).count()

    monkeypatch.setattr("app.services.indexer.MAX_FILE_BYTES", 100)
    grown = dict(FILES)
    grown["app/a.py"] = "x = 1\n" * 40  # 240 bytes > 100; b.py/README stay small

    result, _, _ = _run(db, repo, grown, client=client)

    assert result.chunks_deleted == 0
    assert get_repo_collection(client, repo.id).count() == before
    paths = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    assert "app/a.py" in paths


# ── Mixed-language indexing (LANG-2) ─────────────────────────────────────────

MIXED_FILES = {
    "app/service.py": "def alpha():\n    return 1\n",
    "app/lib/utils.ts": (
        "export interface Options {\n  retries: number;\n}\n\n"
        "export function retry(n: number): number {\n  return n + 1;\n}\n\n"
        "export const shout = (s: string) => s.toUpperCase();\n"
    ),
    "app/Card.tsx": (
        'import type { ReactNode } from "react";\n\n'
        "export const Card = ({ children }: { children: ReactNode }) => (\n"
        '  <section className="card">{children}</section>\n'
        ");\n\n"
        "export default function Page() {\n  return <Card>body</Card>;\n}\n"
    ),
    "README.md": "# Demo\nSome text.\n",
}


def _chunk_meta(client, repo, file_path: str) -> list[dict]:
    """Chunk metadata for one file, read out of Chroma.

    `kind` and `name` live in the vector store rather than the Postgres sync
    log, and it is the vector store that retrieval reads — so this asserts
    against the copy that actually matters.
    """
    got = get_repo_collection(client, repo.id).get(where={"file_path": file_path})
    return list(got["metadatas"])


def test_indexes_mixed_language_repo(db, repo) -> None:
    result, client, _ = _run(db, repo, MIXED_FILES)

    assert result.files_seen == 4
    paths = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    # All three source languages produce rows, not just Python.
    assert {"app/service.py", "app/lib/utils.ts", "app/Card.tsx"} <= paths
    assert get_repo_collection(client, repo.id).count() == result.chunks_added


def test_language_metadata_queryable(db, repo) -> None:
    _, client, _ = _run(db, repo, MIXED_FILES)
    collection = get_repo_collection(client, repo.id)

    got = collection.get(where={"file_path": "app/Card.tsx"})
    assert len(got["ids"]) >= 1
    assert all(m["file_path"] == "app/Card.tsx" for m in got["metadatas"])


def test_typescript_chunks_are_semantic_not_blocks(db, repo) -> None:
    """The check that stops this issue passing on a lie.

    A file with no matching node types still yields ``block`` chunks, so
    counts look right while the semantic chunking does nothing at all. LANG-1
    is only actually wired into the indexer if `kind` says so.
    """
    _, client, _ = _run(db, repo, MIXED_FILES)

    ts = _chunk_meta(client, repo, "app/lib/utils.ts")
    tsx = _chunk_meta(client, repo, "app/Card.tsx")

    assert "block" not in {m["kind"] for m in ts}
    assert "interface" in {m["kind"] for m in ts}
    assert "function" in {m["kind"] for m in tsx}
    # Named, not anonymous — the arrow-component trap, checked end to end
    # through the indexer rather than only in the chunker's own tests.
    assert "Card" in {m["name"] for m in tsx}
    assert {"retry", "shout", "Options"} <= {m["name"] for m in ts}


def test_mixed_repo_rerun_is_idempotent(db, repo) -> None:
    _, client, _ = _run(db, repo, MIXED_FILES)
    result2, _, embedder2 = _run(db, repo, MIXED_FILES, client=client)

    assert result2.chunks_added == 0
    assert result2.chunks_deleted == 0
    assert result2.chunks_skipped > 0
    assert embedder2.calls == []  # nothing re-embedded


def test_changed_tsx_reembeds_only_its_chunks(db, repo) -> None:
    _, client, _ = _run(db, repo, MIXED_FILES)

    changed = dict(MIXED_FILES)
    changed["app/Card.tsx"] = MIXED_FILES["app/Card.tsx"].replace("body", "changed")
    result, _, embedder = _run(db, repo, changed, client=client)

    assert result.chunks_added >= 1
    # Only the .tsx file was touched: the .py and .ts chunks stay put.
    assert result.chunks_added == sum(embedder.calls)
    py_row = db.scalars(
        select(RepoEmbedding).where(RepoEmbedding.file_path == "app/service.py")
    ).one()
    assert py_row.content_hash == chunk_source(
        "app/service.py", MIXED_FILES["app/service.py"]
    )[0].content_hash


def test_deleted_tsx_cleans_up_vectors_and_rows(db, repo) -> None:
    _, client, _ = _run(db, repo, MIXED_FILES)
    before = get_repo_collection(client, repo.id).count()

    remaining = {k: v for k, v in MIXED_FILES.items() if k != "app/Card.tsx"}
    result, _, _ = _run(db, repo, remaining, client=client)

    assert result.chunks_deleted > 0
    assert get_repo_collection(client, repo.id).count() == before - result.chunks_deleted
    paths = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    assert "app/Card.tsx" not in paths
    assert "app/lib/utils.ts" in paths  # its sibling is untouched


def test_chunk_index_stable_across_runs(db, repo) -> None:
    """Unstable node ordering would silently re-embed the world every run.

    ``chunk_index`` is half of the sync log's identity. If the chunker emitted
    definitions in a different order between runs, every (file_path,
    chunk_index) pair would point at different content, every hash would
    mismatch, and an unchanged repository would re-embed in full — expensive,
    and wrong in a way no error message would report.
    """
    _, client, _ = _run(db, repo, MIXED_FILES)

    def identity() -> set[tuple[str, int]]:
        return {
            (row.file_path, row.chunk_index)
            for row in db.scalars(
                select(RepoEmbedding).where(RepoEmbedding.repo_id == repo.id)
            )
        }

    first = identity()
    result2, _, _ = _run(db, repo, MIXED_FILES, client=client)

    assert identity() == first
    # Which is the same thing the skip count is asserting from the other side.
    assert result2.chunks_skipped == len(first)


# ── Remediation: re-indexing removes what was already embedded (LANG-2) ──────

SECRET = "postgresql://postgres:hunter2@localhost:5432/liffy"

FILES_WITH_DOTENV = {
    "app/service.py": "def alpha():\n    return 1\n",
    ".env": f"DATABASE_URL={SECRET}\nANTHROPIC_API_KEY=sk-ant-not-a-real-key\n",
}


class FilteringGitHub(FakeGitHub):
    """FakeGitHub that applies the real indexability filter.

    The plain fake returns every key it was given, which is what makes it
    useful for building a *pre-fix* index. This one behaves like the real
    ``GitHubClient``, whose ``list_repository_files`` filters through
    ``_is_indexable``.
    """

    def list_repository_files(self, owner, repo, ref=None):
        return [p for p in sorted(self.files) if _is_indexable(p)]


def _chroma_docs(client, repo) -> list[str]:
    return list(get_repo_collection(client, repo.id).get(include=["documents"])["documents"])


def test_reindexing_purges_already_embedded_secrets(db, repo) -> None:
    """Re-indexing *remediates*; it does not merely stop adding.

    Matters for a repository that had a dotenv committed and indexed before
    the exclusion existed. The purge is an emergent property of two unrelated
    pieces of code — `.env` drops out of ``list_repository_files``, so its
    keys never reach ``seen_keys``, so the stale-cleanup removes them from
    Chroma *and* Postgres. Nothing else marks that path as load-bearing for a
    security guarantee, so this does: disabling stale-cleanup fails here.

    **Local purging cannot undo an embedding request that already went out.**
    Under a hosted ``EMBEDDING_PROVIDER`` the values were transmitted when
    they were first indexed, and deleting the vectors afterwards does not
    reach them. Those have to be rotated. See docs/indexing.md.
    """
    # Pre-fix state: the unfiltered fake lets `.env` through, exactly as the
    # indexer did before the exclusion existed.
    _, client, _ = _run(db, repo, FILES_WITH_DOTENV)

    assert any(SECRET in doc for doc in _chroma_docs(client, repo))
    dotenv_rows = db.scalars(
        select(RepoEmbedding).where(
            RepoEmbedding.repo_id == repo.id, RepoEmbedding.file_path == ".env"
        )
    ).all()
    assert len(dotenv_rows) >= 1

    # Post-fix: the same tree, seen through the real filter.
    result = index_repository(
        db,
        repo,
        gh=FilteringGitHub(FILES_WITH_DOTENV),
        chroma_client=client,
        embedder=FakeEmbeddings(),
    )

    assert result.chunks_deleted >= 1
    assert not any(SECRET in doc for doc in _chroma_docs(client, repo))
    assert (
        db.scalars(
            select(RepoEmbedding).where(
                RepoEmbedding.repo_id == repo.id, RepoEmbedding.file_path == ".env"
            )
        ).all()
        == []
    )
    # The rest of the repo is untouched — this is a targeted purge, not a wipe.
    assert ".env" not in set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    assert "app/service.py" in set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
