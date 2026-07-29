"""Tests for the embedding providers.

The LocalEmbeddings tests run the real ONNX model. No API key is involved —
that is the property worth protecting, since it means CI and demos cannot be
broken by someone else's account state. The model itself is a one-off ~90MB
download that fastembed caches; if it cannot be fetched (offline CI), those
tests skip loudly rather than failing the suite.
"""

import pytest

from app.config import settings
from app.llm.embeddings import LocalEmbeddings, OpenAIEmbeddings, get_embedding_provider

BGE_SMALL_DIMENSIONS = 384

# Two functions that do the same thing with different names, versus a config
# file. Deliberately not near-identical strings — matching on shared tokens
# would prove nothing about the embedding.
RELATED_A = "def get_user(db, user_id):\n    return db.query(User).filter(User.id == user_id).first()"
RELATED_B = "def fetch_account(session, account_id):\n    return session.query(Account).get(account_id)"
UNRELATED = "server {\n    listen 443 ssl;\n    ssl_certificate /etc/nginx/cert.pem;\n}"


@pytest.fixture(scope="module")
def embedder() -> LocalEmbeddings:
    try:
        return LocalEmbeddings()
    except Exception as exc:  # network unavailable, or the model cannot be fetched
        pytest.skip(f"local embedding model unavailable: {exc}")


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = (sum(x * x for x in a) ** 0.5) * (sum(y * y for y in b) ** 0.5)
    return dot / norm


def test_local_embeddings_returns_correct_dimensions(embedder: LocalEmbeddings) -> None:
    vectors = embedder.embed_texts([RELATED_A, UNRELATED])

    assert len(vectors) == 2
    assert all(len(v) == BGE_SMALL_DIMENSIONS for v in vectors)


def test_local_embeddings_are_deterministic(embedder: LocalEmbeddings) -> None:
    first = embedder.embed_texts([RELATED_A])
    second = embedder.embed_texts([RELATED_A])

    assert first == second


def test_local_embeddings_batches(embedder: LocalEmbeddings) -> None:
    # More inputs than one internal batch; all returned, in order.
    texts = [f"def f{i}():\n    return {i}" for i in range(250)]

    vectors = embedder.embed_texts(texts)

    assert len(vectors) == 250
    assert all(len(v) == BGE_SMALL_DIMENSIONS for v in vectors)
    # Order preserved: re-embedding one input matches its slot in the batch.
    assert embedder.embed_texts([texts[7]])[0] == vectors[7]


def test_similar_texts_score_higher_than_unrelated(embedder: LocalEmbeddings) -> None:
    """Proves the vectors carry meaning, not just the right shape.

    The deterministic fake in conftest produces correctly-shaped vectors that
    are semantically meaningless; it would pass every other test in this file
    and fail this one.
    """
    a, b, other = embedder.embed_texts([RELATED_A, RELATED_B, UNRELATED])

    related = _cosine(a, b)
    unrelated = _cosine(a, other)

    assert related > unrelated, f"related={related:.4f} unrelated={unrelated:.4f}"


def test_get_embedding_provider_selects_on_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "embedding_provider", "local")
    assert isinstance(get_embedding_provider(), LocalEmbeddings)


def test_get_embedding_provider_selects_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "embedding_provider", "openai")
    monkeypatch.setattr(settings, "openai_api_key", "sk-test-not-a-real-key")

    provider = get_embedding_provider()

    # Constructed, never called — OpenAIEmbeddings does no I/O until embed_texts.
    assert isinstance(provider, OpenAIEmbeddings)


def test_local_is_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    # An unrecognised value must not silently fall through to a provider that
    # needs a key; local is the safe default.
    monkeypatch.setattr(settings, "embedding_provider", "typo-provider")
    assert isinstance(get_embedding_provider(), LocalEmbeddings)
