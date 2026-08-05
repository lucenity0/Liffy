"""Codebase indexer (report §7.1): GitHub -> Tree-sitter chunks -> embeddings
-> per-repo ChromaDB collection, with ``repo_embeddings`` rows as the sync log
so re-runs only embed new or changed chunks (idempotent by content hash).
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.llm.embeddings import EmbeddingProvider
from app.models.repo_embedding import RepoEmbedding
from app.models.repository import Repository
from app.services.chunker import CodeChunk, chunk_source
from app.services.github_service import GitHubAuthError, GitHubClient, GitHubRateLimitError
from app.services.rag_service import get_repo_collection

# Files larger than this are skipped (vendored bundles, fixtures, etc.).
MAX_FILE_BYTES = 200_000

# Chunks embedded and upserted per round trip.
#
# A memory control, not a throughput knob: the local embedder holds a batch's
# text and activations at once, so this decides whether the worker survives a
# large repository. Measured here (281 files, ~3k chunks), worker RSS:
#
#   unbatched   ~430MB through the walk, then one step to 5.5GB → SIGKILL
#   batch=128   ~450MB through the walk, then 2.9GB → 4.6GB → completes
#
# Peak still *climbs across batches* rather than returning to baseline, so
# something in the embedder is not releasing between calls. Under 8GB of
# headroom this can still die, and a bigger repository may yet — the constant
# buys room to chase that separately, it does not fix it.
EMBED_BATCH = 128

# The first logger in the backend. Celery captures stdlib loggers on the worker,
# which is the only process this module runs in, so a skipped file surfaces in
# the worker log without any logging configuration to add.
logger = logging.getLogger(__name__)


class IndexingError(RuntimeError):
    """A run that could not produce an index at all.

    Distinct from the per-file skips this module absorbs: those leave a real,
    if incomplete, index behind. This says the run has nothing to show and the
    repository must not be marked indexed.

    Not ``GitHubError`` — the condition counts chunking failures as well as
    fetch failures, so a GitHub-specific type would be a lie half the time.
    """


@dataclass
class IndexResult:
    files_seen: int = 0
    chunks_added: int = 0  # embedded + upserted this run
    chunks_skipped: int = 0  # unchanged (hash match)
    chunks_deleted: int = 0  # stale (file removed or shrank)
    files_failed: int = 0  # fetch or chunk raised; skipped, existing chunks kept


def _chunk_id(file_path: str, chunk_index: int) -> str:
    return f"{file_path}:{chunk_index}"


def index_repository(
    db: Session,
    repo: Repository,
    *,
    gh: GitHubClient,
    chroma_client,
    embedder: EmbeddingProvider,
    ref: str | None = None,
) -> IndexResult:
    owner, name = repo.full_name.split("/", 1)
    result = IndexResult()
    collection = get_repo_collection(chroma_client, repo.id)

    existing_rows: dict[tuple[str, int], RepoEmbedding] = {
        (row.file_path, row.chunk_index): row
        for row in db.scalars(select(RepoEmbedding).where(RepoEmbedding.repo_id == repo.id))
    }
    seen_keys: set[tuple[str, int]] = set()

    def keep_existing_chunks(file_path: str) -> None:
        """Mark a skipped file's chunks as still current.

        Every path that gives up on a file mid-run has to call this. The
        stale-cleanup below deletes every existing row whose key is not in
        ``seen_keys``, so skipping without it deletes that file's chunks from
        Chroma *and* Postgres — turning "could not read it this run" into
        "destroyed its index", which is strictly worse than doing nothing.

        Named rather than repeated inline because forgetting it is silent: the
        run succeeds, the counters look right, and the data is gone.
        """
        seen_keys.update(key for key in existing_rows if key[0] == file_path)

    to_embed: list[CodeChunk] = []
    for file_path in gh.list_repository_files(owner, name, ref=ref):
        result.files_seen += 1
        try:
            content = gh.get_file_content(owner, name, file_path, ref=ref)
        except (GitHubAuthError, GitHubRateLimitError):
            # Scope is the whole run, not this file. Neither a dead credential
            # nor an exhausted quota starts working three files later, so
            # skipping would spend one doomed request per file in the
            # repository and report "800 files failed" instead of the actual
            # reason. Caught before the broader clause below because both are
            # `GitHubError` subclasses.
            #
            # Aborting is right for both; **what they mean is not.** A revoked
            # token needs the user to reconnect; a rate limit is transient and
            # self-healing, and telling someone to reconnect a healthy account
            # is the one message with no action behind it. Re-raised as-is so
            # the distinction survives to the caller rather than being
            # flattened here.
            raise
        except Exception:
            # Deliberately wider than `GitHubError`: `_get` only wraps
            # `httpx.HTTPStatusError`, so a connect error or a read timeout
            # arrives as a raw `httpx` exception and is not a `GitHubError` at
            # all — and at a per-file network call site those are the likeliest
            # failures of the lot. Anything that is not the global auth case
            # above is treated as "this file, this run".
            #
            # `except Exception` rather than a bare `except`, so
            # KeyboardInterrupt and SystemExit still stop the worker.
            logger.exception("fetch failed, skipping %s", file_path)
            keep_existing_chunks(file_path)
            result.files_failed += 1
            continue

        if len(content.encode("utf-8", "replace")) > MAX_FILE_BYTES:
            # Too large to re-embed, but keep its existing chunks: a file that
            # grew past the limit must not be purged by the stale-cleanup below.
            keep_existing_chunks(file_path)
            continue
        try:
            chunks = chunk_source(file_path, content)
        except Exception:
            # One unchunkable file must not cost the run. Unguarded, anything
            # raised here propagates out of this loop, out of the task, and
            # past `repo.indexed_at` and `db.commit()` below — so the
            # repository stays permanently "never indexed" and every chunk
            # already prepared is discarded.
            #
            # `except Exception` rather than a bare `except`: KeyboardInterrupt
            # and SystemExit should still stop the worker.
            #
            # The path goes in the message rather than in `extra=`, because
            # nothing in this project configures a structured handler and
            # `extra` would leave the one useful detail invisible.
            logger.exception("chunking failed, skipping %s", file_path)
            keep_existing_chunks(file_path)
            result.files_failed += 1
            continue

        for chunk in chunks:
            key = (chunk.file_path, chunk.chunk_index)
            seen_keys.add(key)
            row = existing_rows.get(key)
            if row is not None and row.content_hash == chunk.content_hash:
                result.chunks_skipped += 1
                continue
            to_embed.append(chunk)

    # A run in which nothing could be read is not an index, and must not be
    # reported as one: `indexed_at` is what the API turns into
    # `status="indexed"`, and the frontend stops polling the moment it sees
    # that — leaving "Indexed · 0 chunks" with nothing behind it, and every
    # review against that repository silently retrieving no context. Skipping a
    # *single* file is fine precisely because the rest of the run still produced
    # an index; when there is no rest, that premise is gone.
    #
    # Raised here rather than just before `indexed_at` because Chroma is not
    # transactional — by then the stale-cleanup below would have deleted
    # vectors, and a Postgres rollback would leave rows pointing at nothing.
    # `files_seen` guards the empty repository, legitimately indexed with zero.
    if result.files_seen and result.files_failed == result.files_seen:
        raise IndexingError(
            f"every file failed ({result.files_failed} of {result.files_seen}); "
            "refusing to mark the repository indexed"
        )

    if to_embed:
        now = datetime.now(timezone.utc)
        # Batched because embedding every changed chunk in one call held the
        # whole repository's text and activations at once and went straight into
        # the OOM killer — no row, no error, and re-indexing this repository had
        # never once completed. See EMBED_BATCH for the measurements. The upsert
        # is batched for the same reason: it carries every document body a
        # second time, over HTTP to Chroma.
        for start in range(0, len(to_embed), EMBED_BATCH):
            batch = to_embed[start : start + EMBED_BATCH]
            vectors = embedder.embed_texts([c.text for c in batch])
            collection.upsert(
                ids=[_chunk_id(c.file_path, c.chunk_index) for c in batch],
                embeddings=vectors,
                documents=[c.text for c in batch],
                metadatas=[
                    {
                        "file_path": c.file_path,
                        "chunk_index": c.chunk_index,
                        "start_line": c.start_line,
                        "end_line": c.end_line,
                        "kind": c.kind,
                        "name": c.name or "",
                    }
                    for c in batch
                ],
            )
            for chunk in batch:
                key = (chunk.file_path, chunk.chunk_index)
                row = existing_rows.get(key)
                if row is None:
                    db.add(
                        RepoEmbedding(
                            repo_id=repo.id,
                            file_path=chunk.file_path,
                            chunk_index=chunk.chunk_index,
                            content_hash=chunk.content_hash,
                            indexed_at=now,
                        )
                    )
                else:
                    row.content_hash = chunk.content_hash
                    row.indexed_at = now
        result.chunks_added = len(to_embed)

    # Remove chunks whose (file, index) no longer exists: deleted or shrunk files.
    stale = [key for key in existing_rows if key not in seen_keys]
    if stale:
        collection.delete(ids=[_chunk_id(path, idx) for path, idx in stale])
        for key in stale:
            db.delete(existing_rows[key])
        result.chunks_deleted = len(stale)

    # Persist how this run went alongside the timestamp that says it happened.
    # Overwritten rather than accumulated: these describe the *last* run, so a
    # later clean run clears the caveat instead of carrying an old failure
    # forward forever.
    #
    # Written even when zero — that is what lets the API tell "this run skipped
    # nothing" apart from "this repository predates the counter", which is what
    # a NULL means.
    repo.last_index_failed_files = result.files_failed
    repo.last_indexed_files_seen = result.files_seen
    repo.indexed_at = datetime.now(timezone.utc)
    repo.indexing_started_at = None
    db.commit()
    return result
