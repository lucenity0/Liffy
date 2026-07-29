"""Embedding provider seam (report §7.1 step 04).

The pipeline only sees the ``EmbeddingProvider`` protocol; tests inject a
deterministic fake, production defaults to a local ONNX model and can be
pointed at any OpenAI-compatible embeddings API instead.

Embedding dimensions differ between providers (bge-small is 384,
``text-embedding-3-small`` is 1536) and a ChromaDB collection is fixed to the
dimension it was created with. Switching provider therefore always means
dropping the collection and re-indexing — there is no migration path.
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


class LocalEmbeddings:
    """ONNX embeddings that run in-process — no API key, no quota, no billing.

    Chosen over ``sentence-transformers`` because fastembed is ONNX-based and
    does not pull in torch, which would dominate the Docker image.

    The model (~90MB) downloads on first use. In Docker that happens inside the
    container unless it is baked into the image; a surprise download mid-demo
    is worth avoiding.
    """

    def __init__(self, model: str | None = None) -> None:
        from fastembed import TextEmbedding  # deferred: importing loads ONNX

        self.model = model or settings.local_embedding_model
        self._embedder = TextEmbedding(model_name=self.model)

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        # fastembed yields numpy arrays; ChromaDB and the tests both want lists.
        return [vector.tolist() for vector in self._embedder.embed(texts)]


def get_embedding_provider() -> EmbeddingProvider:
    if settings.embedding_provider == "openai":
        return OpenAIEmbeddings()
    return LocalEmbeddings()
