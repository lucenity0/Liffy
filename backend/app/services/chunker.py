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

# The node names below were read off each grammar rather than assumed. Three of
# them are not what the language's own vocabulary suggests: Ruby's class and
# module nodes are bare `class` and `module`, Rust suffixes everything `_item`,
# and C calls a struct a `struct_specifier`. Guessing here is silent — a wrong
# name simply never matches, the file falls to the module path, and the only
# visible symptom is a lower named fraction.
_DEFINITION_TYPES["java"] = frozenset(
    {
        "class_declaration",
        "interface_declaration",
        "enum_declaration",
        "record_declaration",
        "annotation_type_declaration",
        # Never top-level in Java, so these only matter for a fragment, but
        # costing nothing is cheaper than reasoning about when they appear.
        "method_declaration",
        "constructor_declaration",
    }
)
_DEFINITION_TYPES["go"] = frozenset(
    {"function_declaration", "method_declaration", "type_declaration"}
)
_DEFINITION_TYPES["rust"] = frozenset(
    {
        "function_item",
        "struct_item",
        "trait_item",
        "enum_item",
        "impl_item",
        "mod_item",
        "union_item",
        "type_item",
        "macro_definition",
    }
)
_DEFINITION_TYPES["c_sharp"] = frozenset(
    {
        # Block-scoped namespaces nest every type one level down, and the walk
        # is top-level only, so without this a conventional C# file yields one
        # anonymous region. File-scoped `namespace App;` puts types at the top.
        "namespace_declaration",
        "file_scoped_namespace_declaration",
        "class_declaration",
        "interface_declaration",
        "struct_declaration",
        "enum_declaration",
        "record_declaration",
        "delegate_declaration",
        "method_declaration",
    }
)
_DEFINITION_TYPES["c"] = frozenset(
    {"function_definition", "struct_specifier", "enum_specifier", "union_specifier", "type_definition"}
)
_DEFINITION_TYPES["cpp"] = _DEFINITION_TYPES["c"] | frozenset(
    {"namespace_definition", "class_specifier", "template_declaration"}
)
_DEFINITION_TYPES["ruby"] = frozenset({"module", "class", "method", "singleton_method"})
_DEFINITION_TYPES["php"] = frozenset(
    {
        "namespace_definition",
        "class_declaration",
        "interface_declaration",
        "trait_declaration",
        "enum_declaration",
        "function_definition",
    }
)
# Shell functions only. `command` also carries a `name` field, so including it
# would index every invocation in a script as a definition and report a named
# fraction near 100% on files containing no functions at all.
_DEFINITION_TYPES["bash"] = frozenset({"function_definition"})
# Both of these collapse several source-level keywords onto one node type:
# Kotlin `class`, `interface` and `enum class` are all `class_declaration`, and
# Swift `struct`, `class` and `enum` likewise. The kind reported is therefore
# "class" for all of them, which is coarser than the source but not wrong, and
# the name is unaffected.
# `property_declaration` is deliberately absent from both. A top-level `val x = 1`
# is a constant, not a definition, and the file already treats constants that way:
# `export const EDGE = {a: 1}` is excluded in TypeScript by `_definition_node` and
# joins the surrounding module text. Registering it here also indexed badly, since
# Kotlin puts the identifier under a nested `variable_declaration` rather than on a
# `name` field, so the chunk came out anonymous and kinded `function`.
_DEFINITION_TYPES["kotlin"] = frozenset(
    {"class_declaration", "object_declaration", "function_declaration"}
)
_DEFINITION_TYPES["swift"] = frozenset(
    {
        "class_declaration",
        "protocol_declaration",
        "function_declaration",
        "typealias_declaration",
    }
)
_DEFINITION_TYPES["scala"] = frozenset(
    {
        "class_definition",  # also `case class`
        "object_definition",
        "trait_definition",
        "function_definition",
        "type_definition",
        "val_definition",
    }
)
# `assignment_statement` and its wrapper are candidates rather than definitions:
# `local x = 1` shares their node type with `M.area = function(w)`, and only the
# assigned value separates the two. `_definition_node` decides, exactly as it
# does for `export const` in JavaScript.
_DEFINITION_TYPES["lua"] = frozenset(
    {"function_declaration", "assignment_statement", "variable_declaration"}
)
_DEFINITION_TYPES["matlab"] = frozenset({"function_definition", "class_definition"})
_DEFINITION_TYPES["zig"] = frozenset({"function_declaration", "variable_declaration"})
_DEFINITION_TYPES["objc"] = frozenset(
    {"class_interface", "class_implementation", "protocol_declaration", "function_definition"}
)
_DEFINITION_TYPES["elixir"] = frozenset({"call"})
_DEFINITION_TYPES["haskell"] = frozenset(
    {"function", "signature", "data_type", "class", "type_alias", "newtype"}
)
# Dart's top-level functions parse as a `function_signature` followed by a
# sibling `function_body`, so registering the signature would name a chunk
# holding no implementation and leave the body in a separate anonymous one.
# Class-level constructs span their whole body and are registered instead;
# top-level functions join the module text intact, which keeps the code
# together at the cost of the label. Dart is class-oriented enough that this is
# the better trade.
_DEFINITION_TYPES["dart"] = frozenset(
    {"class_definition", "enum_declaration", "mixin_declaration", "extension_declaration"}
)

# Values that make a `const` binding a function rather than a constant.
_CALLABLE_VALUES = frozenset({"arrow_function", "function_expression"})

_CLASS_NODES = frozenset(
    {
        # Python, Dart, Scala and MATLAB all spell it `class_definition`.
        "class_definition",
        "class_declaration",
        "abstract_class_declaration",
        "class_specifier",
        # Ruby's node is bare `class`. Haskell's typeclass node is *also* bare
        # `class`; it is nearer an interface, but the two are indistinguishable
        # by type and this set is checked first, so a typeclass reports "class".
        # The name is unaffected, which is what retrieval matches on.
        "class",
        "object_declaration",  # Kotlin `object Foo { }`
        "object_definition",  # Scala
        "class_interface",  # Objective-C
        "class_implementation",  # Objective-C
        "data_type",  # Haskell
        "newtype",  # Haskell
        "struct_specifier",
        "struct_declaration",
        "struct_item",
        "record_declaration",
        "union_specifier",
        "union_item",
    }
)
_INTERFACE_NODES = frozenset(
    {
        "interface_declaration",
        "type_alias_declaration",
        "enum_declaration",
        "enum_specifier",
        "enum_item",
        "trait_item",
        "trait_declaration",
        "type_definition",
        "type_item",
        "type_declaration",  # Go: struct or interface, decided by the type_spec
        "delegate_declaration",
        "protocol_declaration",  # Swift, Objective-C
        "typealias_declaration",  # Swift
        "trait_definition",  # Scala
        "type_definition",  # Scala
        "type_alias",  # Haskell
    }
)
# A namespace is a container rather than a definition. Where it has a body it is
# expanded into its contents by `_expand_containers`; where it is only a header
# (`namespace App;` in C# and PHP) the types are already siblings and it stands
# on its own as a small named region.
_MODULE_NODES = frozenset(
    {
        "namespace_declaration",
        "file_scoped_namespace_declaration",
        "namespace_definition",
        "module",  # Ruby
        "mod_item",  # Rust
    }
)

# The node types that terminate the C/C++ declarator chain. `identifier` alone
# covers a free function and nothing else: an out-of-line member definition,
# which is most of a real translation unit, ends at `qualified_identifier`, and
# destructors and operator overloads have their own types again. Stopping short
# returns no name, so the definition indexes anonymously and nothing reports it.
_DECLARATOR_NAMES = frozenset(
    {
        "identifier",
        "field_identifier",
        "qualified_identifier",
        "destructor_name",
        "operator_name",
    }
)

# Containers that hold the definitions directly rather than behind a `body`
# field. Haskell puts every top-level declaration inside one `declarations`
# node, so without expanding it a module is a single chunk regardless of size.
_INLINE_CONTAINER_NODES = frozenset({"declarations"})

# Node types whose name is the first `identifier` child rather than a `name`
# field. Zig declares a struct as `const Point = struct {...}`, and Objective-C
# puts the class name first among several identifiers on the interface line.
_FIRST_IDENTIFIER_NAMED = frozenset(
    {"variable_declaration", "class_interface", "class_implementation"}
)

# Elixir has no definition syntax: `defmodule`, `def` and friends are macro
# calls, so every one of them parses as `call` and so does `IO.puts`. The type
# alone cannot separate them and the macro name has to be read from the source,
# which is what `_elixir_definition_name` does.
_ELIXIR_DEFINING_MACROS = frozenset(
    {"defmodule", "def", "defp", "defmacro", "defmacrop", "defprotocol", "defimpl", "defstruct"}
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


def _java_language() -> Language:
    import tree_sitter_java

    return Language(tree_sitter_java.language())


def _go_language() -> Language:
    import tree_sitter_go

    return Language(tree_sitter_go.language())


def _rust_language() -> Language:
    import tree_sitter_rust

    return Language(tree_sitter_rust.language())


def _c_sharp_language() -> Language:
    import tree_sitter_c_sharp

    return Language(tree_sitter_c_sharp.language())


def _c_language() -> Language:
    import tree_sitter_c

    return Language(tree_sitter_c.language())


def _cpp_language() -> Language:
    import tree_sitter_cpp

    return Language(tree_sitter_cpp.language())


def _ruby_language() -> Language:
    import tree_sitter_ruby

    return Language(tree_sitter_ruby.language())


def _php_language() -> Language:
    import tree_sitter_php

    # `language_php` parses a file containing `<?php` tags, which is what a
    # `.php` file is. The sibling `language_php_only` expects tagless source.
    return Language(tree_sitter_php.language_php())


def _bash_language() -> Language:
    import tree_sitter_bash

    return Language(tree_sitter_bash.language())


def _kotlin_language() -> Language:
    import tree_sitter_kotlin

    return Language(tree_sitter_kotlin.language())


def _swift_language() -> Language:
    import tree_sitter_swift

    return Language(tree_sitter_swift.language())


def _scala_language() -> Language:
    import tree_sitter_scala

    return Language(tree_sitter_scala.language())


def _lua_language() -> Language:
    import tree_sitter_lua

    return Language(tree_sitter_lua.language())


def _matlab_language() -> Language:
    import tree_sitter_matlab

    return Language(tree_sitter_matlab.language())


def _zig_language() -> Language:
    import tree_sitter_zig

    return Language(tree_sitter_zig.language())


def _objc_language() -> Language:
    import tree_sitter_objc

    return Language(tree_sitter_objc.language())


def _elixir_language() -> Language:
    import tree_sitter_elixir

    return Language(tree_sitter_elixir.language())


def _haskell_language() -> Language:
    import tree_sitter_haskell

    return Language(tree_sitter_haskell.language())


def _dart_language() -> Language:
    import tree_sitter_dart

    return Language(tree_sitter_dart.language())


# Language registry: extension -> (language name, grammar factory). Adding a
# language is one entry here and its grammar package in requirements.txt.
#
# One entry per extension, rather than a grammar map and a parallel
# extension -> language map. The two were keyed identically and read together
# on every call, so an extension added to one and forgotten in the other was
# a KeyError out of `chunk_source` — and the indexer calls it in a bare loop,
# which turns one missing line here into a failed run over the whole
# repository. A single map makes half-adding a language unrepresentable.
#
# The name is the join to _DEFINITION_TYPES above and is genuinely many-to-one
# with the factory: `.ts` and `.tsx` need different grammars but share one set
# of node names.
_LANGUAGES: dict[str, tuple[str, Callable[[], Language]]] = {
    ".py": ("python", _python_language),
    ".ts": ("typescript", _typescript_language),
    ".tsx": ("typescript", _tsx_language),
    ".js": ("javascript", _javascript_language),
    # JSX is valid in plain `.js` across the React ecosystem, and the
    # JavaScript grammar accepts it.
    ".jsx": ("javascript", _javascript_language),
    ".mjs": ("javascript", _javascript_language),
    ".cjs": ("javascript", _javascript_language),
    ".java": ("java", _java_language),
    ".go": ("go", _go_language),
    ".rs": ("rust", _rust_language),
    ".cs": ("c_sharp", _c_sharp_language),
    ".c": ("c", _c_language),
    # `.h` is ambiguous and is far more often C than C++, so it takes the C
    # grammar. `.hpp` is unambiguous and takes the C++ one. The cost of being
    # wrong is asymmetric: C read as C++ mostly parses, C++ read as C does not.
    ".h": ("c", _c_language),
    ".cpp": ("cpp", _cpp_language),
    ".cc": ("cpp", _cpp_language),
    ".cxx": ("cpp", _cpp_language),
    ".hpp": ("cpp", _cpp_language),
    ".hh": ("cpp", _cpp_language),
    ".rb": ("ruby", _ruby_language),
    ".php": ("php", _php_language),
    ".sh": ("bash", _bash_language),
    ".bash": ("bash", _bash_language),
    ".kt": ("kotlin", _kotlin_language),
    ".kts": ("kotlin", _kotlin_language),
    ".swift": ("swift", _swift_language),
    ".scala": ("scala", _scala_language),
    ".sc": ("scala", _scala_language),
    ".lua": ("lua", _lua_language),
    # `.m` is resolved by content, not by this entry — see `_language_for`. The
    # entry names Objective-C because that is the fallback when the file offers
    # no evidence either way.
    ".m": ("objc", _objc_language),
    ".mm": ("objc", _objc_language),
    ".zig": ("zig", _zig_language),
    ".ex": ("elixir", _elixir_language),
    ".exs": ("elixir", _elixir_language),
    ".hs": ("haskell", _haskell_language),
    ".dart": ("dart", _dart_language),
    # Not a real file extension. `.m` resolves here through `_language_for`
    # when the file shows no Objective-C syntax, which is the only way MATLAB
    # is reachable at all: `.m` is the only extension it has.
    ".matlab": ("matlab", _matlab_language),
}

_parsers: dict[str, Parser] = {}


def _parser_for(extension: str) -> Parser | None:
    if extension not in _LANGUAGES:
        return None
    if extension not in _parsers:
        _parsers[extension] = Parser(_LANGUAGES[extension][1]())
    return _parsers[extension]


# `.m` is MATLAB's only extension and Objective-C's principal one, so mapping it
# to either language by name alone makes the other unreachable. These markers
# are Objective-C syntax that is not valid MATLAB, checked in preference order:
# a file containing any of them is not a MATLAB script.
_OBJC_MARKERS = ("@interface", "@implementation", "@protocol", "@end", "#import")


def _language_for(extension: str, source: str) -> tuple[str, Parser] | None:
    """Resolve one file to (language name, parser), or None to window it.

    Extension alone decides every language but one. Rather than let `.m` pick a
    winner and silently strip the loser of its only extension, the ambiguous
    case is settled by looking at the file.
    """
    if extension == ".m" and not any(marker in source for marker in _OBJC_MARKERS):
        parser = _parser_for(".matlab")
        if parser is not None:
            return "matlab", parser

    parser = _parser_for(extension)
    if parser is None:
        return None
    return _LANGUAGES[extension][0], parser


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

    if node.type == "assignment_statement":
        # The arrow-function trap again, in Lua. `M.area = function(w) ... end`
        # is how a large share of real Lua defines its functions, and matching
        # only `function_declaration` misses every one: 263 of them in a single
        # mid-sized plugin, all landing in module text unnamed.
        value = node.child_by_field_name("value")
        return node if value is not None and value.type == "function_definition" else None

    if node.type in {"lexical_declaration", "variable_declaration"}:
        # Lua wraps `local f = function() end` in a declaration around the
        # assignment, so the decision belongs to the assignment below it.
        inner = next(
            (c for c in node.named_children if c.type == "assignment_statement"), None
        )
        if inner is not None:
            return _definition_node(inner)

        # Zig reaches here too, because `const Point = struct {...}` is also a
        # `variable_declaration`, and it has no `variable_declarator` children
        # at all. Falling through to the JS rule would return None and drop
        # every Zig type, so a node with no declarators is treated as itself.
        if not any(c.type == "variable_declarator" for c in node.named_children):
            return node
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


def _name_node(node: Node) -> Node | None:
    """The node holding the declared identifier, or None.

    Most grammars expose it on a `name` field and stop here. Three do not, and
    each is a definition that would otherwise index as anonymous:

        int add(int a) {}      C/C++  -> name is under the declarator chain
        type Shape interface   Go     -> name is on the nested type_spec
        impl Shape for Point   Rust   -> the subject is on the `type` field
    """
    direct = node.child_by_field_name("name")
    if direct is not None:
        return direct

    if node.type == "function_definition":
        # `int *f(void)` nests a pointer_declarator around the function one, so
        # follow the chain rather than assuming a fixed depth.
        current = node.child_by_field_name("declarator")
        for _ in range(4):
            if current is None:
                return None
            if current.type in _DECLARATOR_NAMES:
                return current
            current = current.child_by_field_name("declarator")
        return None

    if node.type == "type_declaration":
        for child in node.named_children:
            if child.type == "type_spec":
                return child.child_by_field_name("name")
        return None

    if node.type == "impl_item":
        return node.child_by_field_name("type")

    if node.type in _FIRST_IDENTIFIER_NAMED:
        # Zig declares a type as `const Point = struct {...}` and Objective-C
        # lists the class before its superclass, so in both the first
        # identifier is the declared name and any later one is a reference.
        for child in node.named_children:
            if child.type == "identifier":
                return child
        return None

    return None


def _elixir_definition(node: Node, source: bytes) -> Node | None:
    """The name node of an Elixir definition, or None if this call is not one.

    Elixir has no definition syntax: `defmodule Foo do` and `IO.puts "x"` are
    both a `call`, so the node type cannot separate a definition from any other
    expression and the macro being invoked has to be read out of the source.
    """
    target = node.child_by_field_name("target")
    if target is None or target.type != "identifier":
        return None
    macro = source[target.start_byte : target.end_byte].decode("utf-8", "replace")
    if macro not in _ELIXIR_DEFINING_MACROS:
        return None

    # `arguments` is a named child rather than a field on this grammar, so it
    # has to be found by type. Asking for the field returns None and silently
    # unnames every definition in the file.
    arguments = next((c for c in node.named_children if c.type == "arguments"), None)
    if arguments is None or not arguments.named_children:
        return None
    first = arguments.named_children[0]
    # `defmodule App.Shape` names an alias; `def area(w)` wraps the name in a
    # further call carrying the parameter list.
    if first.type == "call":
        return first.child_by_field_name("target")
    return first


def _node_name(node: Node, source: bytes) -> str | None:
    if node.type == "call":
        name_node = _elixir_definition(node, source)
        if name_node is None:
            return None
        return source[name_node.start_byte : name_node.end_byte].decode("utf-8", "replace")

    target = _definition_node(node)
    if target is None:
        return None
    # `variable_declarator` carries the binding name, so an arrow component is
    # named after its const rather than landing as an anonymous blob.
    name_node = _name_node(target)
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
    if target.type in _MODULE_NODES:
        return "module"
    return "function"


def _expand_containers(nodes: list[Node]) -> list[Node]:
    """Replace namespace-like containers with their contents.

    The walk in ``chunk_source`` is top-level only, so without this a
    conventionally-formatted C#, C++ or Rust file is *one* node: the namespace.
    It would be emitted whole and then sliced at the character budget, which is
    fixed windowing with a name attached, for exactly the languages where
    namespaces are universal.

    Only containers that actually have a body are expanded. C# `namespace App;`
    and PHP `namespace App;` carry no body and their types are already siblings,
    so those are left alone.

    The cost is that the container's own header text, ``namespace App {``, sits
    outside every child node and is therefore dropped. That is a real loss and
    the alternative is worse: the classes inside carry the names retrieval
    matches on, and one chunk per file carries none of them.
    """
    out: list[Node] = []
    for node in nodes:
        if node.type in _INLINE_CONTAINER_NODES:
            out.extend(_expand_containers(node.named_children))
            continue
        body = node.child_by_field_name("body") if node.type in _MODULE_NODES else None
        if body is None:
            out.append(node)
        else:
            out.extend(_expand_containers(body.named_children))
    return out


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
    resolved = _language_for(extension, source)
    # Name and parser come from one resolution rather than two lookups, so they
    # cannot disagree about which language this is — which matters now that one
    # extension is settled by content rather than by the registry alone.
    parser = resolved[1] if resolved else None
    definition_types = _DEFINITION_TYPES[resolved[0]] if resolved else frozenset()
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

        for child in _expand_containers(tree.root_node.children):
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
