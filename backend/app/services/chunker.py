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

# Per-language definition node types. Was a single global set of Python node
# names; JS/TS share no node names with Python at all, so the registry has to
# be keyed by language before a second grammar can be added.
_DEFINITION_TYPES: dict[str, frozenset[str]] = {
    "python": frozenset(
        {"function_definition", "class_definition", "decorated_definition"}
    ),
    "javascript": frozenset(
        {
            "function_declaration",
            "generator_function_declaration",
            "class_declaration",
            # Only *sometimes* a definition — `export const x = () => {}` is,
            # `export const x = {a: 1}` is not. `_definition_node` decides.
            "lexical_declaration",
            "variable_declaration",
            "export_statement",
        }
    ),
}

# TypeScript is JavaScript plus the type-level declarations.
_DEFINITION_TYPES["typescript"] = _DEFINITION_TYPES["javascript"] | frozenset(
    {
        "interface_declaration",
        "type_alias_declaration",
        "enum_declaration",
        "abstract_class_declaration",
    }
)

# Values that make a `const` binding a function rather than a constant.
_CALLABLE_VALUES = frozenset({"arrow_function", "function_expression"})

_CLASS_NODES = frozenset({"class_definition", "class_declaration", "abstract_class_declaration"})
_INTERFACE_NODES = frozenset(
    {"interface_declaration", "type_alias_declaration", "enum_declaration"}
)


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


def _typescript_language() -> Language:
    import tree_sitter_typescript

    return Language(tree_sitter_typescript.language_typescript())


def _tsx_language() -> Language:
    import tree_sitter_typescript

    # A separate grammar, not a flag. Parsing `.tsx` with the plain TypeScript
    # grammar does not error — it silently mis-parses JSX, because `<Foo>` is a
    # type assertion there and an element here.
    return Language(tree_sitter_typescript.language_tsx())


def _javascript_language() -> Language:
    import tree_sitter_javascript

    return Language(tree_sitter_javascript.language())


# Language registry: extension -> language factory. Adding a language is one
# entry here, one in _EXTENSION_LANGUAGE below, and its grammar package in
# requirements.txt.
_LANGUAGES: dict[str, Callable[[], Language]] = {
    ".py": _python_language,
    ".ts": _typescript_language,
    ".tsx": _tsx_language,
    ".js": _javascript_language,
    # JSX is valid in plain `.js` across the React ecosystem, and the
    # JavaScript grammar accepts it.
    ".jsx": _javascript_language,
    ".mjs": _javascript_language,
    ".cjs": _javascript_language,
}

# Which set of node names applies. Several extensions share one language, so
# this is deliberately separate from the grammar registry above.
_EXTENSION_LANGUAGE: dict[str, str] = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
}

_parsers: dict[str, Parser] = {}


def _parser_for(extension: str) -> Parser | None:
    if extension not in _LANGUAGES:
        return None
    if extension not in _parsers:
        _parsers[extension] = Parser(_LANGUAGES[extension]())
    return _parsers[extension]


def _definition_node(node: Node) -> Node | None:
    """Peel wrappers until the node that actually *is* the definition.

    Returns None when there is no definition inside — which is how a constant
    or a re-export gets excluded, since those share their node type with
    genuine definitions:

        export const Foo = () => <div/>   ->  variable_declarator (a function)
        export const EDGE = {a: 1}        ->  None (a constant)
        export { helper }                 ->  None (a re-export)

    Python's ``decorated_definition`` already needed this same unwrap, so the
    shape is not new — only the number of wrappers is.
    """
    if node.type == "decorated_definition":
        inner = node.child_by_field_name("definition")
        return _definition_node(inner) if inner is not None else None

    if node.type == "export_statement":
        # `export default function f() {}` and `export class C {}` both put
        # the real node on this field. `export { a, b }` has no such field,
        # which is exactly why it falls out here.
        inner = node.child_by_field_name("declaration")
        return _definition_node(inner) if inner is not None else None

    if node.type in {"lexical_declaration", "variable_declaration"}:
        for child in node.named_children:
            if child.type != "variable_declarator":
                continue
            value = child.child_by_field_name("value")
            # **The arrow-function trap.** Most React components are
            # `export const Foo = () => {...}`. Matching only
            # `function_declaration` indexes almost none of a modern frontend
            # — and the block-window fallback hides it, because chunks are
            # still produced and only their `kind` and `name` are wrong.
            if value is not None and value.type in _CALLABLE_VALUES:
                return child
        return None

    return node


def _node_name(node: Node, source: bytes) -> str | None:
    target = _definition_node(node)
    if target is None:
        return None
    # `variable_declarator` carries the binding name, so an arrow component is
    # named after its const rather than landing as an anonymous blob.
    name_node = target.child_by_field_name("name")
    if name_node is None:
        return None
    return source[name_node.start_byte : name_node.end_byte].decode("utf-8", "replace")


def _node_kind(node: Node) -> str:
    target = _definition_node(node)
    if target is None:
        return "block"

    if target.type in _CLASS_NODES:
        return "class"
    if target.type in _INTERFACE_NODES:
        return "interface"
    return "function"


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
    definition_types = _DEFINITION_TYPES[_EXTENSION_LANGUAGE[extension]] if parser else frozenset()
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
            # Two gates, not one: the node type has to be a candidate *and*
            # actually contain a definition. `export const x = {a: 1}` clears
            # the first and fails the second, so it joins the surrounding
            # module text instead of masquerading as a function.
            if child.type in definition_types and _definition_node(child) is not None:
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
