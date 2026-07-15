"""Embedding provider seam (report §7.1 step 04).

The pipeline only sees the ``EmbeddingProvider`` protocol; tests inject a
deterministic fake, production uses OpenAI ``text-embedding-3-small``.
"""

from typing import Protocol

from app.config import settings

EMBEDDING_MODEL = "text-embedding-3-small"
_BATCH_SIZE = 100


class EmbeddingProvider(Protocol):
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...


class OpenAIEmbeddings:
    def __init__(self, api_key: str | None = None, model: str = EMBEDDING_MODEL) -> None:
        from openai import OpenAI  # deferred so tests never need the key

        self.model = model
        self._client = OpenAI(api_key=api_key or settings.openai_api_key)

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), _BATCH_SIZE):
            batch = texts[start : start + _BATCH_SIZE]
            response = self._client.embeddings.create(model=self.model, input=batch)
            vectors.extend(item.embedding for item in response.data)
        return vectors


def get_embedding_provider() -> EmbeddingProvider:
    return OpenAIEmbeddings()
