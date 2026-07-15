"""ChromaDB access layer (report §7.1 step 05, §7.2 steps 02-03, §12).

Client + per-repo collection helpers (BASE-5) and retrieval: embed a diff
chunk, query the repo's collection for the top-k most similar codebase
chunks (BASE-6). Retrieval feeds prompt assembly in the LLM chain (BASE-7).
"""

import uuid
from dataclasses import dataclass

import chromadb
from chromadb.api import ClientAPI
from chromadb.api.models.Collection import Collection

from app.config import settings
from app.llm.embeddings import EmbeddingProvider
from app.services.diff_parser import FileDiff, chunk_text

DEFAULT_TOP_K = 5


def get_chroma_client() -> ClientAPI:
    """HTTP client when CHROMA_HOST is set (docker compose), else a local
    persistent client (bare-metal dev)."""
    if settings.chroma_host:
        return chromadb.HttpClient(host=settings.chroma_host, port=settings.chroma_port)
    return chromadb.PersistentClient(path=settings.chroma_persist_dir)


def collection_name(repo_id: uuid.UUID) -> str:
    return f"repo_{repo_id.hex}"


def get_repo_collection(client: ClientAPI, repo_id: uuid.UUID) -> Collection:
    return client.get_or_create_collection(
        name=collection_name(repo_id),
        metadata={"hnsw:space": "cosine"},
    )


@dataclass(frozen=True)
class RetrievedChunk:
    file_path: str
    start_line: int
    end_line: int
    kind: str
    name: str
    text: str
    distance: float  # cosine distance; lower = more similar


def retrieve_similar(
    chroma_client: ClientAPI,
    repo_id: uuid.UUID,
    query_text: str,
    *,
    embedder: EmbeddingProvider,
    top_k: int = DEFAULT_TOP_K,
    exclude_file: str | None = None,
) -> list[RetrievedChunk]:
    """Top-k codebase chunks most similar to ``query_text``.

    ``exclude_file`` drops hits from the file under review — its own old
    version would otherwise dominate the neighbours with no added signal.
    Unindexed repos and blank queries return `[]` (a review can proceed
    without context rather than crash).
    """
    if not query_text.strip():
        return []
    collection = get_repo_collection(chroma_client, repo_id)
    count = collection.count()
    if count == 0:
        return []

    vector = embedder.embed_texts([query_text])[0]
    result = collection.query(
        query_embeddings=[vector],
        n_results=min(top_k, count),
        where={"file_path": {"$ne": exclude_file}} if exclude_file else None,
        include=["documents", "metadatas", "distances"],
    )

    chunks = [
        RetrievedChunk(
            file_path=meta["file_path"],
            start_line=int(meta["start_line"]),
            end_line=int(meta["end_line"]),
            kind=meta["kind"],
            name=meta["name"],
            text=doc,
            distance=float(dist),
        )
        for doc, meta, dist in zip(
            result["documents"][0], result["metadatas"][0], result["distances"][0]
        )
    ]
    return sorted(chunks, key=lambda c: c.distance)


def retrieve_for_file_diff(
    chroma_client: ClientAPI,
    repo_id: uuid.UUID,
    file_diff: FileDiff,
    *,
    embedder: EmbeddingProvider,
    top_k: int = DEFAULT_TOP_K,
) -> list[RetrievedChunk]:
    """Retrieval for one changed file: query per hunk, merge, de-duplicate by
    (file_path, start_line) keeping the closest, cap at ``top_k`` overall.

    This is the per-file call the review pipeline (BASE-8) makes.
    """
    best: dict[tuple[str, int], RetrievedChunk] = {}
    for hunk_text in chunk_text(file_diff):
        for hit in retrieve_similar(
            chroma_client,
            repo_id,
            hunk_text,
            embedder=embedder,
            top_k=top_k,
            exclude_file=file_diff.path,
        ):
            key = (hit.file_path, hit.start_line)
            if key not in best or hit.distance < best[key].distance:
                best[key] = hit
    return sorted(best.values(), key=lambda c: c.distance)[:top_k]
