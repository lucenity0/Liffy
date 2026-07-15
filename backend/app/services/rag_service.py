"""ChromaDB access layer (report §7.1 step 05, §12: per-repo isolation).

BASE-5 scope: client + per-repo collection helpers used by the indexer.
BASE-6 adds retrieval (embed diff chunk -> top-5 similar codebase chunks).
"""

import uuid

import chromadb
from chromadb.api import ClientAPI
from chromadb.api.models.Collection import Collection

from app.config import settings


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
