import uuid

import chromadb
from conftest import DeterministicEmbeddings, shared_chroma_client

from app.services.diff_parser import parse_diff
from app.services.rag_service import (
    get_repo_collection,
    retrieve_for_file_diff,
    retrieve_similar,
)

REPO_ID = uuid.uuid4()

DOCS = {
    "app/auth.py:0": ("app/auth.py", 1, 8, "function", "verify_token", "def verify_token(t):\n    return jwt.decode(t)"),
    "app/auth.py:1": ("app/auth.py", 10, 20, "function", "issue_token", "def issue_token(u):\n    return jwt.encode(u)"),
    "app/util.py:0": ("app/util.py", 1, 5, "function", "slugify", "def slugify(s):\n    return s.lower()"),
    "app/util.py:1": ("app/util.py", 7, 12, "function", "helper", "def helper():\n    return 42"),
    "app/views.py:0": ("app/views.py", 1, 30, "class", "UserView", "class UserView:\n    def get(self): ..."),
    "app/views.py:1": ("app/views.py", 32, 40, "function", "render", "def render(x):\n    return str(x)"),
}


def _seeded_client() -> tuple[chromadb.api.ClientAPI, DeterministicEmbeddings]:
    client = shared_chroma_client()
    embedder = DeterministicEmbeddings()
    collection = get_repo_collection(client, REPO_ID)
    texts = [d[5] for d in DOCS.values()]
    collection.upsert(
        ids=list(DOCS),
        embeddings=embedder.embed_texts(texts),
        documents=texts,
        metadatas=[
            {"file_path": p, "start_line": s, "end_line": e, "kind": k, "name": n, "chunk_index": 0}
            for p, s, e, k, n, _ in DOCS.values()
        ],
    )
    return client, embedder


def test_exact_text_is_top_hit_with_zero_distance() -> None:
    client, embedder = _seeded_client()
    query = DOCS["app/util.py:0"][5]  # slugify source, verbatim
    hits = retrieve_similar(client, REPO_ID, query, embedder=embedder)
    assert hits[0].name == "slugify"
    assert hits[0].distance < 1e-6
    assert len(hits) == 5  # top_k default, 6 docs available
    assert [h.distance for h in hits] == sorted(h.distance for h in hits)


def test_top_k_is_respected() -> None:
    client, embedder = _seeded_client()
    hits = retrieve_similar(client, REPO_ID, "anything", embedder=embedder, top_k=2)
    assert len(hits) == 2


def test_exclude_file_filters_self_hits() -> None:
    client, embedder = _seeded_client()
    query = DOCS["app/auth.py:0"][5]
    hits = retrieve_similar(
        client, REPO_ID, query, embedder=embedder, exclude_file="app/auth.py"
    )
    assert hits and all(h.file_path != "app/auth.py" for h in hits)


def test_empty_collection_and_blank_query_return_empty() -> None:
    client = shared_chroma_client()
    embedder = DeterministicEmbeddings()
    assert retrieve_similar(client, uuid.uuid4(), "query", embedder=embedder) == []
    seeded, seeded_embedder = _seeded_client()
    assert retrieve_similar(seeded, REPO_ID, "   ", embedder=seeded_embedder) == []
    assert seeded_embedder.calls == [len(DOCS)]  # blank query embedded nothing new


TWO_HUNK_DIFF = """\
diff --git a/app/newfile.py b/app/newfile.py
--- a/app/newfile.py
+++ b/app/newfile.py
@@ -1,2 +1,3 @@
 def a():
+    return slugify_thing
 pass
@@ -10,2 +11,3 @@
 def b():
+    return slugify_thing
 pass
"""


def test_retrieve_for_file_diff_merges_and_dedupes() -> None:
    client, embedder = _seeded_client()
    fd = parse_diff(TWO_HUNK_DIFF)[0]
    hits = retrieve_for_file_diff(client, REPO_ID, fd, embedder=embedder, top_k=4)
    # capped, sorted, unique locations, and never the file under review
    assert 0 < len(hits) <= 4
    keys = [(h.file_path, h.start_line) for h in hits]
    assert len(keys) == len(set(keys))
    assert [h.distance for h in hits] == sorted(h.distance for h in hits)
    assert all(h.file_path != "app/newfile.py" for h in hits)
