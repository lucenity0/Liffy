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
from app.services.github_service import GitHubClient
from app.services.rag_service import get_repo_collection

# Files larger than this are skipped (vendored bundles, fixtures, etc.).
MAX_FILE_BYTES = 200_000

# The first logger in the backend. Celery captures stdlib loggers on the worker,
# which is the only process this module runs in, so a skipped file surfaces in
# the worker log without any logging configuration to add.
logger = logging.getLogger(__name__)


@dataclass
class IndexResult:
    files_seen: int = 0
    chunks_added: int = 0  # embedded + upserted this run
    chunks_skipped: int = 0  # unchanged (hash match)
    chunks_deleted: int = 0  # stale (file removed or shrank)
    files_failed: int = 0  # raised during chunking; skipped, chunks preserved


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

    to_embed: list[CodeChunk] = []
    for file_path in gh.list_repository_files(owner, name, ref=ref):
        result.files_seen += 1
        content = gh.get_file_content(owner, name, file_path, ref=ref)
        if len(content.encode("utf-8", "replace")) > MAX_FILE_BYTES:
            # Too large to re-embed, but keep its existing chunks: a file that
            # grew past the limit must not be purged by the stale-cleanup below.
            seen_keys.update(key for key in existing_rows if key[0] == file_path)
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
            # Same preservation as the oversized branch, for the same reason:
            # without this the stale-cleanup below deletes the file's existing
            # chunks, turning "could not re-chunk" into "index destroyed".
            seen_keys.update(key for key in existing_rows if key[0] == file_path)
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

    if to_embed:
        vectors = embedder.embed_texts([c.text for c in to_embed])
        collection.upsert(
            ids=[_chunk_id(c.file_path, c.chunk_index) for c in to_embed],
            embeddings=vectors,
            documents=[c.text for c in to_embed],
            metadatas=[
                {
                    "file_path": c.file_path,
                    "chunk_index": c.chunk_index,
                    "start_line": c.start_line,
                    "end_line": c.end_line,
                    "kind": c.kind,
                    "name": c.name or "",
                }
                for c in to_embed
            ],
        )
        now = datetime.now(timezone.utc)
        for chunk in to_embed:
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

    repo.indexed_at = datetime.now(timezone.utc)
    db.commit()
    return result
