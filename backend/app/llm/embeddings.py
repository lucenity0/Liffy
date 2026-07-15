"""Embedding provider seam (report §7.1 step 04).

The pipeline only sees the ``EmbeddingProvider`` protocol; tests inject a
deterministic fake, production uses OpenAI ``text-embedding-3-small``.
"""

from typing import Protocol

from app.config import settings

_BATCH_SIZE = 100


class EmbeddingProvider(Protocol):
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...


class OpenAIEmbeddings:
    """Embeddings over any OpenAI-compatible API (OpenAI itself, or e.g.
    Gemini via its compat endpoint when ``settings.openai_base_url`` is set)."""

    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        from openai import OpenAI  # deferred so tests never need the key

        self.model = model or settings.embedding_model
        self._client = OpenAI(
            api_key=api_key or settings.openai_api_key,
            base_url=settings.openai_base_url or None,
        )

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), _BATCH_SIZE):
            batch = texts[start : start + _BATCH_SIZE]
            response = self._client.embeddings.create(model=self.model, input=batch)
            vectors.extend(item.embedding for item in response.data)
        return vectors


def get_embedding_provider() -> EmbeddingProvider:
    return OpenAIEmbeddings()
