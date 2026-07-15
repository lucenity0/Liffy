"""Semantic code chunker (report §7.1 steps 02-03).

Tree-sitter parses source into an AST; we extract function/class-level chunks.
Files without a registered grammar fall back to fixed line windows so every
code file is still indexable. Used by the indexer (BASE-5) and reused for
diff-side chunking later.
"""

import hashlib
from collections.abc import Callable
from dataclasses import dataclass

from tree_sitter import Language, Node, Parser

# Chunks larger than this are split on line boundaries (embedding quality
# degrades on very long inputs; text-embedding-3-small caps at 8191 tokens).
MAX_CHUNK_CHARS = 2000
FALLBACK_WINDOW_LINES = 80

_DEFINITION_TYPES = {"function_definition", "class_definition", "decorated_definition"}


@dataclass(frozen=True)
class CodeChunk:
    file_path: str
    chunk_index: int
    start_line: int  # 1-based, inclusive
    end_line: int  # 1-based, inclusive
    kind: str  # "function" | "class" | "module" | "block"
    name: str | None
    text: str
    content_hash: str


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _python_language() -> Language:
    import tree_sitter_python

    return Language(tree_sitter_python.language())


# Language registry: extension -> language factory. Adding a language is one
# entry here plus its grammar package in requirements.txt.
_LANGUAGES: dict[str, Callable[[], Language]] = {
    ".py": _python_language,
}

_parsers: dict[str, Parser] = {}


def _parser_for(extension: str) -> Parser | None:
    if extension not in _LANGUAGES:
        return None
    if extension not in _parsers:
        _parsers[extension] = Parser(_LANGUAGES[extension]())
    return _parsers[extension]


def _node_name(node: Node, source: bytes) -> str | None:
    if node.type == "decorated_definition":
        inner = node.child_by_field_name("definition")
        return _node_name(inner, source) if inner is not None else None
    name_node = node.child_by_field_name("name")
    if name_node is None:
        return None
    return source[name_node.start_byte : name_node.end_byte].decode("utf-8", "replace")


def _node_kind(node: Node) -> str:
    if node.type == "decorated_definition":
        inner = node.child_by_field_name("definition")
        if inner is not None:
            return _node_kind(inner)
    return "class" if node.type == "class_definition" else "function"


def _split_oversized(text: str, start_line: int) -> list[tuple[str, int, int]]:
    """Split ``text`` into <= MAX_CHUNK_CHARS pieces on line boundaries.

    Returns (piece_text, piece_start_line, piece_end_line) tuples.
    """
    lines = text.splitlines()
    pieces: list[tuple[str, int, int]] = []
    buf: list[str] = []
    buf_start = start_line
    size = 0
    for offset, line in enumerate(lines):
        if buf and size + len(line) + 1 > MAX_CHUNK_CHARS:
            pieces.append(("\n".join(buf), buf_start, start_line + offset - 1))
            buf, size = [], 0
            buf_start = start_line + offset
        buf.append(line)
        size += len(line) + 1
    if buf:
        pieces.append(("\n".join(buf), buf_start, start_line + len(lines) - 1))
    return pieces


def chunk_source(file_path: str, source: str) -> list[CodeChunk]:
    """Chunk one file. Semantic (AST) when a grammar is registered, otherwise
    fixed line windows."""
    if not source.strip():
        return []

    extension = "." + file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""
    parser = _parser_for(extension)
    raw: list[tuple[str, int, int, str, str | None]] = []  # (text, start, end, kind, name)

    if parser is not None:
        source_bytes = source.encode("utf-8")
        tree = parser.parse(source_bytes)
        pending: list[Node] = []  # consecutive non-definition top-level nodes

        def flush_pending() -> None:
            if not pending:
                return
            start_b, end_b = pending[0].start_byte, pending[-1].end_byte
            text = source_bytes[start_b:end_b].decode("utf-8", "replace")
            if text.strip():
                raw.append(
                    (text, pending[0].start_point[0] + 1, pending[-1].end_point[0] + 1, "module", None)
                )
            pending.clear()

        for child in tree.root_node.children:
            if child.type in _DEFINITION_TYPES:
                flush_pending()
                text = source_bytes[child.start_byte : child.end_byte].decode("utf-8", "replace")
                raw.append(
                    (
                        text,
                        child.start_point[0] + 1,
                        child.end_point[0] + 1,
                        _node_kind(child),
                        _node_name(child, source_bytes),
                    )
                )
            else:
                pending.append(child)
        flush_pending()
    else:
        lines = source.splitlines()
        for start in range(0, len(lines), FALLBACK_WINDOW_LINES):
            window = lines[start : start + FALLBACK_WINDOW_LINES]
            text = "\n".join(window)
            if text.strip():
                raw.append((text, start + 1, start + len(window), "block", None))

    chunks: list[CodeChunk] = []
    for text, start, end, kind, name in raw:
        pieces = (
            _split_oversized(text, start) if len(text) > MAX_CHUNK_CHARS else [(text, start, end)]
        )
        for piece_text, piece_start, piece_end in pieces:
            chunks.append(
                CodeChunk(
                    file_path=file_path,
                    chunk_index=len(chunks),
                    start_line=piece_start,
                    end_line=piece_end,
                    kind=kind,
                    name=name,
                    text=piece_text,
                    content_hash=_sha256(piece_text),
                )
            )
    return chunks
