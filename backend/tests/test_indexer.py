import hashlib
import logging

import chromadb
import httpx
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

import app.models  # noqa: F401
from app.database import Base
from app.models.repo_embedding import RepoEmbedding
from app.models.repository import Repository
from app.models.user import User
from app.services.chunker import chunk_source
from app.services.github_service import GitHubAuthError, GitHubError, _is_indexable
from app.services.indexer import IndexingError, index_repository
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


def _run(db, repo, files, embedder=None, client=None, gh=None):
    client = client or shared_chroma_client()
    embedder = embedder or FakeEmbeddings()
    result = index_repository(
        db, repo, gh=gh or FakeGitHub(files), chroma_client=client, embedder=embedder
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


# ── One bad file must not cost the run (INDEXER) ─────────────────────────────


def _raise_on(monkeypatch, bad_path: str) -> None:
    """Make ``chunk_source`` throw for one path and behave for every other."""
    real = chunk_source

    def flaky(file_path: str, source: str):
        if file_path == bad_path:
            raise RuntimeError(f"synthetic chunker failure on {file_path}")
        return real(file_path, source)

    monkeypatch.setattr("app.services.indexer.chunk_source", flaky)


def test_unchunkable_file_does_not_abort_the_run(db, repo, monkeypatch) -> None:
    """The whole point: one throw skips one file, not the repository.

    Asserted against *committed* state rather than the return value, because
    the failure mode is precisely that ``db.commit()`` at the end of
    ``index_repository`` never runs — a return value cannot tell you the
    transaction was thrown away.
    """
    _raise_on(monkeypatch, "app/b.py")

    result, client, _ = _run(db, repo, FILES)

    assert result.files_failed == 1
    assert result.files_seen == 3
    assert result.chunks_added > 0

    db.expire_all()  # force a real read; the identity map would hide a rollback
    assert repo.indexed_at is not None
    paths = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    assert "app/a.py" in paths and "README.md" in paths
    assert "app/b.py" not in paths  # never chunked, so nothing to record
    assert get_repo_collection(client, repo.id).count() == result.chunks_added


def test_unchunkable_file_keeps_its_existing_chunks(db, repo, monkeypatch) -> None:
    """A file that fails on re-index keeps what it already had.

    Without the ``seen_keys`` update the stale-cleanup deletes every row for
    that file from Chroma *and* Postgres, which makes "could not re-chunk"
    strictly worse than doing nothing. Same trap, same fix as
    ``test_oversized_file_keeps_existing_chunks``.
    """
    _, client, _ = _run(db, repo, FILES)
    before = get_repo_collection(client, repo.id).count()

    _raise_on(monkeypatch, "app/b.py")
    result, _, _ = _run(db, repo, FILES, client=client)

    assert result.files_failed == 1
    assert result.chunks_deleted == 0
    assert get_repo_collection(client, repo.id).count() == before
    paths = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    assert "app/b.py" in paths


def test_unchunkable_file_is_logged_with_its_path(db, repo, monkeypatch, caplog) -> None:
    """A silent skip is barely better than a crash.

    ``files_failed`` says how many; only the log says which, and the path has
    to be in the rendered message rather than in ``extra`` — nothing here
    configures a structured handler.
    """
    _raise_on(monkeypatch, "app/b.py")

    with caplog.at_level(logging.ERROR, logger="app.services.indexer"):
        _run(db, repo, FILES)

    assert "app/b.py" in caplog.text
    # exc_info, so the traceback reaches the worker log rather than just a line.
    assert any(record.exc_info for record in caplog.records)


def test_a_file_dropped_from_the_listing_is_still_purged(db, repo, monkeypatch) -> None:
    """The preservation above must not soften stale-cleanup in general.

    Files that leave the listing still have to be purged — that path is what
    remediates an already-embedded secret, and
    ``test_reindexing_purges_already_embedded_secrets`` depends on it. A
    failing file and a departed file are different cases and must stay so,
    which this pins by exercising both in the same run.
    """
    _, client, _ = _run(db, repo, FILES)

    _raise_on(monkeypatch, "app/b.py")
    remaining = {k: v for k, v in FILES.items() if k != "README.md"}
    result, _, _ = _run(db, repo, remaining, client=client)

    paths = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    assert "README.md" not in paths  # dropped from the listing -> purged
    assert "app/b.py" in paths  # present but unchunkable -> kept
    assert result.chunks_deleted >= 1


# ── A file we cannot fetch must not cost the run (INDEXER) ───────────────────


def _fetch_raises(files, bad_path: str, exc: Exception) -> FakeGitHub:
    """A FakeGitHub whose ``get_file_content`` throws for exactly one path."""

    class FetchFailingGitHub(FakeGitHub):
        def get_file_content(self, owner, repo, path, ref=None):
            if path == bad_path:
                raise exc
            return super().get_file_content(owner, repo, path, ref)

    return FetchFailingGitHub(files)


def test_fetch_failure_on_one_file_does_not_abort_the_run(db, repo) -> None:
    """The twin of the chunker guard, on the likelier call site.

    ``get_file_content`` is a network call executed once per file, so a
    transient 500 or a 404 on a file that vanished mid-run is ordinary
    operation. Unguarded it propagates out of the loop and past
    ``repo.indexed_at`` and ``db.commit()``, so one blip leaves the repository
    permanently "never indexed" and discards every chunk already prepared.

    Asserted against *committed* state, because the failure mode is precisely
    that the commit never happens — a return value cannot tell you the
    transaction was thrown away.
    """
    gh = _fetch_raises(FILES, "app/b.py", GitHubError("GitHub returned HTTP 500"))

    result, client, _ = _run(db, repo, FILES, gh=gh)

    assert result.files_failed == 1
    assert result.files_seen == 3
    assert result.chunks_added > 0

    db.expire_all()  # force a real read; the identity map would hide a rollback
    assert repo.indexed_at is not None
    paths = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    assert "app/a.py" in paths and "README.md" in paths
    assert "app/b.py" not in paths  # never fetched, so nothing to record
    assert get_repo_collection(client, repo.id).count() == result.chunks_added


def test_transport_error_is_treated_as_one_file_failing(db, repo) -> None:
    """The case a ``GitHubError``-only guard would miss entirely.

    ``_get`` wraps ``httpx.HTTPStatusError`` and nothing else, so a connect
    error or a read timeout arrives as a raw ``httpx`` exception that is *not*
    a ``GitHubError``. At a per-file network call site those are the likeliest
    failures of the lot, which is why the guard is wider than the typed error.
    """
    gh = _fetch_raises(FILES, "app/b.py", httpx.ConnectError("connection refused"))

    result, _, _ = _run(db, repo, FILES, gh=gh)

    assert result.files_failed == 1
    db.expire_all()
    assert repo.indexed_at is not None


def test_auth_error_aborts_the_whole_run(db, repo) -> None:
    """The one failure whose scope is the run, not the file.

    A revoked or expired credential will not start working three files later.
    Skipping per file would spend one doomed request for every file in the
    repository and report "N files failed" instead of "the token is dead" —
    so this must propagate, and must *not* be absorbed into ``files_failed``.

    ``GitHubAuthError`` subclasses ``GitHubError``, so this is entirely a
    statement about clause order in ``index_repository``; collapsing the two
    branches is the mistake it exists to catch.
    """
    gh = _fetch_raises(FILES, "app/b.py", GitHubAuthError("GitHub rejected the credentials."))

    with pytest.raises(GitHubAuthError):
        _run(db, repo, FILES, gh=gh)

    db.expire_all()
    assert repo.indexed_at is None  # the run did not complete


def test_fetch_failure_keeps_the_files_existing_chunks(db, repo) -> None:
    """A file that fails to fetch on re-index keeps what it already had.

    Without the ``seen_keys`` preservation the stale-cleanup deletes every row
    for that file from Chroma *and* Postgres, which makes "GitHub blipped"
    strictly worse than not running at all.
    """
    _, client, _ = _run(db, repo, FILES)
    before = get_repo_collection(client, repo.id).count()

    gh = _fetch_raises(FILES, "app/b.py", GitHubError("GitHub returned HTTP 500"))
    result, _, _ = _run(db, repo, FILES, client=client, gh=gh)

    assert result.files_failed == 1
    assert result.chunks_deleted == 0
    assert get_repo_collection(client, repo.id).count() == before
    paths = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    assert "app/b.py" in paths


def test_fetch_failure_is_logged_with_its_path(db, repo, caplog) -> None:
    """``files_failed`` says how many; only the log says which."""
    gh = _fetch_raises(FILES, "app/b.py", GitHubError("GitHub returned HTTP 500"))

    with caplog.at_level(logging.ERROR, logger="app.services.indexer"):
        _run(db, repo, FILES, gh=gh)

    assert "app/b.py" in caplog.text
    # exc_info, so the traceback reaches the worker log rather than just a line.
    assert any(record.exc_info for record in caplog.records)


def test_a_file_dropped_from_the_listing_is_still_purged_when_another_fails(db, repo) -> None:
    """Preserving an unfetchable file must not soften stale-cleanup in general.

    Files that leave the listing still have to be purged — that path is what
    remediates an already-embedded secret, and
    ``test_reindexing_purges_already_embedded_secrets`` depends on it. Both
    cases run together here so the distinction cannot be quietly collapsed.
    """
    _, client, _ = _run(db, repo, FILES)

    remaining = {k: v for k, v in FILES.items() if k != "README.md"}
    gh = _fetch_raises(remaining, "app/b.py", GitHubError("GitHub returned HTTP 500"))
    result, _, _ = _run(db, repo, remaining, client=client, gh=gh)

    paths = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    assert "README.md" not in paths  # dropped from the listing -> purged
    assert "app/b.py" in paths  # present but unfetchable -> kept
    assert result.chunks_deleted >= 1


# ── A run that indexed nothing must not claim it did (INDEXER) ───────────────


def _all_fetches_fail(files, exc: Exception | None = None) -> FakeGitHub:
    """A FakeGitHub where every ``get_file_content`` throws — a partition."""

    class DeadGitHub(FakeGitHub):
        def get_file_content(self, owner, repo, path, ref=None):
            raise exc or httpx.ConnectError("network partition")

    return DeadGitHub(files)


def test_a_run_where_every_file_fails_is_not_an_index(db, repo) -> None:
    """The failure mode the per-file skip introduces if left unbounded.

    Skipping a file is right because the *rest* of the run still produces an
    index. When there is no rest, that premise is gone — and marking the
    repository indexed is worse than the crash it replaced. ``repo.indexed_at``
    is what the API turns into ``status="indexed"``, and ``useRepoStatus``
    stops polling the moment it sees that, so the repository would sit at
    "Indexed - 0 chunks" with no poll left to correct it.
    """
    with pytest.raises(IndexingError, match="every file failed"):
        _run(db, repo, FILES, gh=_all_fetches_fail(FILES))

    db.expire_all()
    assert repo.indexed_at is None  # never indexed, and still says so


def test_a_totally_failed_rerun_does_not_overwrite_a_good_index(db, repo) -> None:
    """A partition during re-index must not erase or restamp a real index.

    The previous ``indexed_at`` is the truthful value here — that *is* when the
    repository was last successfully indexed — and the existing chunks have to
    survive, since a run that read nothing has learned nothing about them.
    """
    _, client, _ = _run(db, repo, FILES)
    db.expire_all()
    first_indexed_at = repo.indexed_at
    before = get_repo_collection(client, repo.id).count()
    paths_before = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )

    with pytest.raises(IndexingError):
        _run(db, repo, FILES, client=client, gh=_all_fetches_fail(FILES))

    db.expire_all()
    assert repo.indexed_at == first_indexed_at  # not restamped
    assert get_repo_collection(client, repo.id).count() == before
    paths_after = set(
        db.scalars(select(RepoEmbedding.file_path).where(RepoEmbedding.repo_id == repo.id))
    )
    assert paths_after == paths_before


def test_nothing_is_written_to_chroma_when_a_run_is_refused(db, repo) -> None:
    """The refusal happens before any store is touched.

    Chroma is not transactional, so raising after the stale-cleanup would
    delete vectors that the Postgres rollback then "restores" as rows pointing
    at nothing. A file dropped from the listing is the case that reaches it:
    it is not preserved by ``keep_existing_chunks``, so it would be purged on
    the way past.
    """
    _, client, _ = _run(db, repo, FILES)
    before = get_repo_collection(client, repo.id).count()

    # README.md leaves the listing *and* every remaining fetch fails.
    remaining = {k: v for k, v in FILES.items() if k != "README.md"}
    with pytest.raises(IndexingError):
        _run(db, repo, remaining, client=client, gh=_all_fetches_fail(remaining))

    assert get_repo_collection(client, repo.id).count() == before  # nothing purged
    db.expire_all()
    rows = db.scalars(select(RepoEmbedding).where(RepoEmbedding.repo_id == repo.id)).all()
    assert len(rows) == before  # Postgres and Chroma still agree


def test_a_partial_failure_still_indexes(db, repo) -> None:
    """The guard must not fire when the run did real work.

    One failure out of three is exactly what the per-file skip exists for, and
    turning that back into a hard failure would undo this whole PR.
    """
    gh = _fetch_raises(FILES, "app/b.py", GitHubError("GitHub returned HTTP 500"))

    result, _, _ = _run(db, repo, FILES, gh=gh)

    assert result.files_failed == 1
    db.expire_all()
    assert repo.indexed_at is not None


def test_an_empty_repository_is_legitimately_indexed(db, repo) -> None:
    """``files_seen == 0`` is not a failure — there was nothing to fail at.

    Guarding on the ratio alone (``0 == 0``) would refuse to index an empty
    repository forever, leaving it polling "Indexing" with nothing coming.
    """
    result, _, _ = _run(db, repo, {})

    assert result.files_seen == 0 and result.files_failed == 0
    db.expire_all()
    assert repo.indexed_at is not None


# ── Surfacing partial failures (#210) ─────────────────────────────────────────


def test_run_persists_the_failure_counts(db, repo) -> None:
    """``files_failed`` outlives the task, so the API has something to read.

    Before this it existed only for the lifetime of the run: the Celery result
    dict goes to a backend nothing reads, and the only other trace was a log
    line in the worker.
    """
    class OneBadFile(FakeGitHub):
        def get_file_content(self, owner, repo_name, path, ref=None):
            if path == "app/a.py":
                raise RuntimeError("500 from GitHub")
            return super().get_file_content(owner, repo_name, path, ref=ref)

    result, _, _ = _run(db, repo, FILES, gh=OneBadFile(FILES))

    assert result.files_failed == 1
    assert repo.last_index_failed_files == 1
    assert repo.last_indexed_files_seen == result.files_seen


def test_a_clean_run_persists_zero_not_null(db, repo) -> None:
    """`0` is a measurement; `None` means the repository predates the counter.

    Only the first earns a clean chip on its own evidence.
    """
    _run(db, repo, FILES)

    assert repo.last_index_failed_files == 0
    assert repo.last_indexed_files_seen == 3


def test_skipped_count_survives_a_rerun_by_being_reset(db, repo) -> None:
    """A later clean run clears the caveat rather than accumulating.

    These describe the *last* run. Accumulating would mean one transient 500
    marks a repository as partial forever.
    """
    class OneBadFile(FakeGitHub):
        def get_file_content(self, owner, repo_name, path, ref=None):
            if path == "app/a.py":
                raise RuntimeError("500 from GitHub")
            return super().get_file_content(owner, repo_name, path, ref=ref)

    _, client, embedder = _run(db, repo, FILES, gh=OneBadFile(FILES))
    assert repo.last_index_failed_files == 1

    _run(db, repo, FILES, client=client, embedder=embedder)

    assert repo.last_index_failed_files == 0
