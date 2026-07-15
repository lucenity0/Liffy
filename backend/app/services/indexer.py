"""Codebase indexer (report §7.1): GitHub -> Tree-sitter chunks -> embeddings
-> per-repo ChromaDB collection, with ``repo_embeddings`` rows as the sync log
so re-runs only embed new or changed chunks (idempotent by content hash).
"""

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


@dataclass
class IndexResult:
    files_seen: int = 0
    chunks_added: int = 0  # embedded + upserted this run
    chunks_skipped: int = 0  # unchanged (hash match)
    chunks_deleted: int = 0  # stale (file removed or shrank)


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
        for chunk in chunk_source(file_path, content):
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
