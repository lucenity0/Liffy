from app.services.chunker import MAX_CHUNK_CHARS, chunk_source

PY_SOURCE = '''\
import os
from typing import Any

CONSTANT = 42


def first(x: int) -> int:
    """Docstring."""
    return x + CONSTANT


class Greeter:
    def __init__(self, name: str) -> None:
        self.name = name

    def greet(self) -> str:
        return f"hi {self.name}"


@staticmethod
def decorated() -> None:
    pass
'''


def test_python_semantic_chunks() -> None:
    chunks = chunk_source("app/sample.py", PY_SOURCE)
    kinds = [(c.kind, c.name) for c in chunks]
    assert kinds == [
        ("module", None),  # imports + CONSTANT
        ("function", "first"),
        ("class", "Greeter"),
        ("function", "decorated"),
    ]
    # class chunk spans the whole class, methods included
    greeter = chunks[2]
    assert "def __init__" in greeter.text and "def greet" in greeter.text
    assert (greeter.start_line, greeter.end_line) == (12, 17)
    # indices are sequential
    assert [c.chunk_index for c in chunks] == [0, 1, 2, 3]


def test_hash_is_stable_and_content_sensitive() -> None:
    a = chunk_source("f.py", PY_SOURCE)
    b = chunk_source("f.py", PY_SOURCE)
    assert [c.content_hash for c in a] == [c.content_hash for c in b]
    changed = chunk_source("f.py", PY_SOURCE.replace("42", "43"))
    assert changed[0].content_hash != a[0].content_hash  # module chunk changed
    assert changed[1].content_hash == a[1].content_hash  # function text unchanged


def test_oversized_chunk_is_split() -> None:
    body = "\n".join(f"    x{i} = {i}" for i in range(400))
    source = f"def big():\n{body}\n"
    chunks = chunk_source("big.py", source)
    assert len(chunks) > 1
    assert all(len(c.text) <= MAX_CHUNK_CHARS for c in chunks)
    assert all(c.kind == "function" and c.name == "big" for c in chunks)
    # line ranges tile the function without gaps
    assert chunks[0].start_line == 1
    for prev, cur in zip(chunks, chunks[1:]):
        assert cur.start_line == prev.end_line + 1


def test_fallback_line_windows_for_unknown_extension() -> None:
    source = "\n".join(f"line {i}" for i in range(1, 201))
    chunks = chunk_source("notes.md", source)
    assert [c.kind for c in chunks] == ["block", "block", "block"]
    assert (chunks[0].start_line, chunks[0].end_line) == (1, 80)
    assert (chunks[2].start_line, chunks[2].end_line) == (161, 200)


def test_empty_source_yields_no_chunks() -> None:
    assert chunk_source("empty.py", "") == []
    assert chunk_source("blank.py", "   \n\n") == []
