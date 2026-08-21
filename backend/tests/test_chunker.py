from app.services.chunker import (
    _FILENAMES,
    _LANGUAGES,
    MAX_CHUNK_CHARS,
    chunk_source,
)

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
    # `.nolang` rather than a real extension: this test previously used `.md`
    # and stopped exercising the fallback the moment Markdown was registered.
    assert ".nolang" not in _LANGUAGES
    source = "\n".join(f"line {i}" for i in range(1, 201))
    chunks = chunk_source("notes.nolang", source)
    assert [c.kind for c in chunks] == ["block", "block", "block"]
    assert (chunks[0].start_line, chunks[0].end_line) == (1, 80)
    assert (chunks[2].start_line, chunks[2].end_line) == (161, 200)


def test_empty_source_yields_no_chunks() -> None:
    assert chunk_source("empty.py", "") == []
    assert chunk_source("blank.py", "   \n\n") == []


# ── TypeScript / JavaScript (LANG-1) ─────────────────────────────────────────

TS_SOURCE = """\
import { useState } from "react";

export interface Props {
  title: string;
}

export type Alias = Props | null;

export const EDGE: Record<string, string> = { a: "1" };

export function declared(x: number): number {
  return x + 1;
}

export class Widget {
  private n = 0;

  render(): number {
    return this.n;
  }
}
"""

TSX_SOURCE = """\
import type { ReactNode } from "react";

interface CardProps {
  title: string;
  children: ReactNode;
}

export const Card = ({ title, children }: CardProps) => (
  <section className="card">
    <h2>{title}</h2>
    {children}
  </section>
);

export default function Page() {
  return <Card title="hi">body</Card>;
}
"""

JS_SOURCE = """\
const PREFIX = "liffy";

export function shout(text) {
  return `${PREFIX}: ${text.toUpperCase()}`;
}

export const whisper = (text) => text.toLowerCase();

export class Bell {
  ring() {
    return "ding";
  }
}
"""


def _by_name(chunks) -> dict[str, object]:
    return {c.name: c for c in chunks if c.name is not None}


def test_typescript_function_declaration() -> None:
    chunks = chunk_source("app/sample.ts", "export function foo() { return 1; }\n")

    named = _by_name(chunks)
    assert "foo" in named
    assert named["foo"].kind == "function"


def test_typescript_class_and_methods() -> None:
    named = _by_name(chunk_source("app/sample.ts", TS_SOURCE))

    assert named["Widget"].kind == "class"
    assert named["declared"].kind == "function"


def test_exported_arrow_component_is_named() -> None:
    """The arrow-function trap.

    Most React components are ``export const Foo = () => {...}`` — an
    ``arrow_function`` inside a ``lexical_declaration`` inside an
    ``export_statement``. Matching only ``function_declaration`` indexes
    almost none of a modern frontend, and the block-window fallback hides it:
    chunks are still produced, so counts look right while ``kind`` and
    ``name`` are silently wrong. Hence asserting on both, never on count.
    """
    named = _by_name(chunk_source("app/Card.tsx", TSX_SOURCE))

    assert "Card" in named, "the exported arrow component was not chunked by name"
    assert named["Card"].kind == "function"
    assert named["Card"].name == "Card"


def test_const_object_is_not_mistaken_for_a_function() -> None:
    """`export const EDGE = {...}` shares its node type with an arrow component.

    Type alone cannot separate them; only the declarator's value can. Getting
    this wrong labels every exported constant a function.
    """
    chunks = chunk_source("app/sample.ts", TS_SOURCE)
    named = _by_name(chunks)

    assert "EDGE" not in named
    # It is not dropped either — it joins the surrounding module text.
    assert any(c.kind == "module" and "EDGE" in c.text for c in chunks)


def test_tsx_parses_jsx_without_error() -> None:
    chunks = chunk_source("app/Card.tsx", TSX_SOURCE)
    named = _by_name(chunks)

    assert named["Page"].kind == "function"
    assert "<section" in named["Card"].text


def test_tsx_uses_the_tsx_grammar_not_the_typescript_one() -> None:
    """Asserted on the parse tree, because chunk output cannot catch it.

    ``tree_sitter_typescript`` ships two grammars, and in the plain
    TypeScript one ``<section>`` is a type assertion rather than an element.
    The mis-parse is silent: top-level node types survive, so chunk names and
    kinds still come out right and *every other test in this file stays
    green* when ``.tsx`` is pointed at the wrong grammar. I checked — 15/15
    passed with it swapped.

    What does differ is the tree underneath, so that is what is asserted. The
    second assertion keeps the first honest: it proves the check is
    discriminating rather than vacuously true of both grammars.
    """
    from app.services.chunker import _parser_for

    source = TSX_SOURCE.encode()

    tsx_parser = _parser_for(".tsx")
    assert tsx_parser is not None
    assert not tsx_parser.parse(source).root_node.has_error

    ts_parser = _parser_for(".ts")
    assert ts_parser is not None
    assert ts_parser.parse(source).root_node.has_error


def test_interface_declaration() -> None:
    named = _by_name(chunk_source("app/sample.ts", TS_SOURCE))

    assert named["Props"].kind == "interface"
    assert named["Alias"].kind == "interface"


def test_javascript_file_uses_js_grammar() -> None:
    named = _by_name(chunk_source("app/bell.js", JS_SOURCE))

    assert named["shout"].kind == "function"
    assert named["whisper"].kind == "function"  # arrow, again
    assert named["Bell"].kind == "class"


def test_every_javascript_flavour_chunks_semantically() -> None:
    for extension in (".js", ".jsx", ".mjs", ".cjs"):
        named = _by_name(chunk_source(f"app/bell{extension}", JS_SOURCE))
        assert named["shout"].kind == "function", extension
        assert named["whisper"].kind == "function", extension


def test_unknown_extension_still_falls_back() -> None:
    """A file with no registered grammar windows rather than failing.

    The extension is asserted absent from the registry rather than hardcoded on
    trust. This test previously used `.rb`, which silently stopped testing
    anything the moment Ruby was registered: the fallback assertion started
    failing for the right reason, but only because the example had become a
    supported language. Deriving it from `_LANGUAGES` means adding a grammar
    can no longer quietly invalidate the case.
    """
    # A synthetic extension, not a real language. This test has now been broken
    # twice by registering the language it happened to use as its example, once
    # for Ruby and once for Haskell, and on both occasions it had silently
    # stopped testing the fallback long before anyone noticed. Nothing will ever
    # claim `.nolang`, so it cannot happen a third time.
    extension = ".nolang"
    assert extension not in _LANGUAGES, f"{extension} is registered; pick another"

    chunks = chunk_source(f"app/script{extension}", "define hello\n  print 'hi'\nend\n")

    assert [c.kind for c in chunks] == ["block"]
    assert all(c.name is None for c in chunks)


def test_real_component_chunks_by_its_real_exports() -> None:
    """A genuine file from the frontend, not a synthetic one-liner.

    Synthetic snippets pass against a chunker that is subtly wrong; a real
    component carries imports, a typed props object, a const map and a
    doc comment all competing for the same top level.
    """
    from pathlib import Path

    source = Path(__file__).parent.joinpath("fixtures/ReviewComment.tsx").read_text(
        encoding="utf-8"
    )
    chunks = chunk_source("frontend/src/components/review/ReviewComment.tsx", source)
    named = _by_name(chunks)

    assert named["ReviewComment"].kind == "function"
    # EDGE is a const map in that file and must not be labelled a function.
    assert "EDGE" not in named
    assert all(c.kind != "block" for c in chunks), "fell back to line windows"


# ── Registry integrity (CHUNKER) ─────────────────────────────────────────────


def test_every_registered_extension_takes_the_parser_path() -> None:
    """The guarded path, walked once per registered extension.

    ``chunk_source`` looks a language name up in ``_DEFINITION_TYPES``
    whenever a parser exists, and an extension whose name is missing from that
    map raises ``KeyError``. The indexer calls ``chunk_source`` in a bare loop
    with no per-file ``try``, so that is not one skipped file — it aborts the
    whole repository index run before ``indexed_at`` is ever written.

    Nothing else in this file catches it. The two fallback tests use ``.md``
    and ``.rb``, which have no parser and so never reach the lookup at all,
    which is why the suite stayed green with the drift present. This walks
    ``_LANGUAGES`` itself, so an extension added later is covered without
    anyone remembering to write a test for it.

    ``kind != "block"`` is what proves the parser path actually ran — "block"
    is emitted only by the line-window fallback.
    """
    from app.services.chunker import _LANGUAGES

    for extension in _LANGUAGES:
        chunks = chunk_source(f"probe{extension}", "x = 1\n")

        assert chunks, extension
        assert all(c.kind != "block" for c in chunks), extension


def test_every_registered_language_has_definition_types() -> None:
    """The one drift a single registry cannot make unrepresentable.

    Folding the grammar and language-name maps into one entry per extension
    means a half-added extension is no longer valid data. ``_DEFINITION_TYPES``
    is a third registry keyed by language *name* rather than by extension,
    though, so adding a language is still two edits — and forgetting the
    second one is the same ``KeyError`` in the same place.

    Asserted against the registries directly so it fails at test time rather
    than inside a Celery worker, and so it still holds for a language whose
    grammar is too awkward to exercise in the test above.
    """
    from app.services.chunker import _DEFINITION_TYPES, _LANGUAGES

    names = {name for name, _ in _LANGUAGES.values()}

    assert names <= _DEFINITION_TYPES.keys(), sorted(names - _DEFINITION_TYPES.keys())


# One representative file per grammar added in LANG-3. Each is written so the
# top-level nodes are exactly what the walk sees, since `chunk_source` iterates
# the root's children and does not recurse: a Java method lives inside its
# class and is therefore part of the class chunk, not a chunk of its own.
_LANGUAGE_SAMPLES: dict[str, tuple[str, str]] = {
    ".java": ("Widget", "public class Widget {\n    public void draw() {}\n}\n"),
    ".go": ("Area", "package main\n\nfunc Area(w float64) float64 { return w }\n"),
    ".rs": ("area", "pub fn area(w: f64) -> f64 { w }\n"),
    # `Rect`, not `App`: the namespace is expanded into its contents, so the
    # class is the definition and the namespace is not one.
    ".cs": ("Rect", "namespace App {\n    public class Rect {}\n}\n"),
    ".c": ("add", "int add(int a, int b) { return a + b; }\n"),
    ".cpp": ("Widget", "class Widget {\npublic:\n    void draw();\n};\n"),
    ".rb": ("Widget", "class Widget\n  def area; 2; end\nend\n"),
    ".php": ("helper", "<?php\nfunction helper(int $x): int { return $x; }\n"),
    ".sh": ("greet", "#!/usr/bin/env bash\ngreet() { echo hi; }\n"),
    # Newlines inside the class body are load-bearing for Kotlin: the grammar
    # separates declarations on them, so `class W { fun d() {} }` on one line
    # parses to an ERROR node while the same code across three lines does not.
    # A one-line sample here would look like a broken grammar rather than a
    # badly-written fixture.
    ".kt": ("Widget", "class Widget {\n    fun draw() {}\n}\n"),
    ".swift": ("Point", "struct Point {\n    var x: Int\n}\n"),
    ".scala": ("Rect", "class Rect(val w: Double) {\n  def area: Double = w\n}\n"),
    ".lua": ("M.area", "function M.area(w)\n  return w\nend\n"),
    ".zig": ("Point", "pub const Point = struct {\n    x: i32,\n};\n"),
    ".ex": ("App.Shape", "defmodule App.Shape do\n  def area(w) do\n    w\n  end\nend\n"),
    ".hs": ("area", "module App where\n\narea :: Int -> Int\narea x = x\n"),
    ".dart": ("Rect", "class Rect {\n  final double w;\n  double area() => w;\n}\n"),
    ".mm": ("Widget", "@interface Widget : NSObject\n- (void)draw;\n@end\n"),
    ".sql": ("users", "CREATE TABLE users (\n  id INT\n);\n"),
    ".css": (".review", ".review {\n  color: red;\n}\n"),
    ".yml": ("jobs", "name: CI\njobs:\n  build:\n    runs-on: ubuntu\n"),
    ".json": ("name", '{\n  "name": "liffy"\n}\n'),
    ".md": ("Setup", "# Setup\n\nInstall it.\n"),
    ".html": ("html", "<html>\n<body><p>x</p></body>\n</html>\n"),
    ".dockerfile": ("builder", "FROM node:20 AS builder\nRUN npm ci\n"),
}


def test_each_added_language_chunks_semantically() -> None:
    """Every grammar added in LANG-3 yields a *named* chunk.

    The name is the assertion that matters. A wrong node type in
    ``_DEFINITION_TYPES`` does not raise: the node simply never matches, the
    file falls through to the module path, and the only symptom is a chunk that
    is anonymous. That is precisely the silent failure the named-chunk fraction
    exists to expose, so it is pinned here per language rather than trusted.
    """
    for extension, (expected_name, source) in _LANGUAGE_SAMPLES.items():
        chunks = chunk_source(f"app/sample{extension}", source)
        names = {c.name for c in chunks if c.name}

        assert chunks, extension
        assert expected_name in names, (extension, sorted(names))


def test_c_and_cpp_names_come_from_the_declarator_chain() -> None:
    """`function_definition` carries no `name` field in the C family.

    The identifier sits under `declarator`, one level down for a plain function
    and two for a pointer return, so a fixed-depth lookup would name one and
    not the other.
    """
    plain = chunk_source("app/a.c", "int add(int a) { return a; }\n")
    pointer = chunk_source("app/b.c", "char *dup(char *s) { return s; }\n")

    assert [c.name for c in plain] == ["add"]
    assert [c.name for c in pointer] == ["dup"]


def test_bash_indexes_functions_but_not_commands() -> None:
    """`command` also has a `name` field, so including it would name everything.

    A script of bare invocations must produce no named chunks at all; without
    this distinction the named fraction reads near 100% on files defining
    nothing.
    """
    functions = chunk_source("app/f.sh", "greet() { echo hi; }\n")
    commands = chunk_source("app/c.sh", "set -euo pipefail\necho hello\nls -la\n")

    assert [c.name for c in functions] == ["greet"]
    assert all(c.name is None for c in commands)


def test_cpp_out_of_line_member_definitions_are_named() -> None:
    """`identifier` alone terminates the chain for free functions only.

    Out-of-line member definitions are the bulk of a real translation unit and
    end at `qualified_identifier`; destructors and operator overloads have types
    of their own again. Stopping short returns no name, so the definition
    indexes anonymously and nothing anywhere reports it — the silent failure the
    named-chunk fraction exists to catch, reintroduced one node type at a time.
    """
    cases = {
        "int add(int a) { return a; }": "add",
        "void Widget::draw() {}": "Widget::draw",
        "Widget::~Widget() {}": "Widget::~Widget",
        "bool Widget::operator==(const Widget& o) const { return true; }": "Widget::operator==",
        "char *Widget::dup(char *s) { return s; }": "Widget::dup",
    }
    for source, expected in cases.items():
        assert [c.name for c in chunk_source("a.cpp", source)] == [expected], source


def test_namespace_body_is_expanded_into_its_definitions() -> None:
    """A namespace is a container, not a definition.

    Emitting it whole makes a conventionally-formatted C# or C++ file a single
    chunk that is then sliced at the character budget, which is fixed windowing
    with a name attached for precisely the languages where namespaces are
    universal.
    """
    source = (
        "namespace App {\n"
        "    public class A { public void M() {} }\n"
        "    public class B { public void N() {} }\n"
        "}\n"
    )
    named = {c.name: c for c in chunk_source("a.cs", source) if c.name}

    assert sorted(named) == ["A", "B"]
    assert named["A"].kind == "class"
    assert "namespace" not in named


def test_header_only_namespaces_are_left_alone() -> None:
    """`namespace App;` has no body and its types are already siblings.

    Expanding on the presence of a `body` field rather than on the node type
    keeps this case working: there is nothing to descend into, and the types
    must not be lost.
    """
    named = {c.name for c in chunk_source("a.cs", "namespace App;\nclass A {}\nclass B {}\n") if c.name}

    assert {"A", "B"} <= named


def test_top_level_property_is_not_a_definition() -> None:
    """A top-level `val` is a constant, and constants join the module text.

    The same rule TypeScript already applies to `export const EDGE = {a: 1}`.
    Registering `property_declaration` also indexed badly in Kotlin, where the
    identifier sits under a nested `variable_declaration` rather than on a
    `name` field, so the chunk came out anonymous *and* kinded `function`.
    """
    for path, source in [("a.kt", "val x = 1\n"), ("a.swift", "var x: Int = 1\n")]:
        chunks = chunk_source(path, source)
        assert [c.kind for c in chunks] == ["module"], path
        assert all(c.name is None for c in chunks), path


def test_dot_m_is_resolved_by_content_not_by_extension() -> None:
    """`.m` is MATLAB's only extension and Objective-C's principal one.

    Mapping it to either by name alone leaves the other unreachable, and for
    MATLAB that means unreachable entirely. The file decides instead: anything
    carrying Objective-C syntax is Objective-C, and everything else is MATLAB.
    """
    objc = "#import <Foundation/Foundation.h>\n@implementation Widget\n- (void)draw {}\n@end\n"
    matlab = "function r = area(w)\n    r = w * w;\nend\n"

    assert "Widget" in {c.name for c in chunk_source("a.m", objc)}
    assert [c.name for c in chunk_source("a.m", matlab)] == ["area"]


def test_elixir_definitions_are_told_apart_from_ordinary_calls() -> None:
    """Elixir has no definition syntax, so the node type cannot decide.

    `defmodule Foo do` and `IO.puts "x"` are both a `call`. The macro name has
    to be read out of the source, which means an ordinary call must come back
    unnamed rather than being indexed as a definition of itself.
    """
    defined = chunk_source("a.ex", "defmodule App.Shape do\n  def area(w) do\n    w\n  end\nend\n")
    assert [c.name for c in defined] == ["App.Shape"]

    called = chunk_source("a.ex", 'IO.puts "hello"\nEnum.map([1], fn x -> x end)\n')
    assert all(c.name is None for c in called)


def test_zig_types_are_not_swallowed_by_the_javascript_rule() -> None:
    """`const Point = struct {}` is a `variable_declaration`, same as JS.

    The JavaScript branch of `_definition_node` looks for a `variable_declarator`
    to decide whether a binding is a function, and Zig has none, so falling
    through it would return None and drop every Zig type.
    """
    chunks = chunk_source("a.zig", "pub const Point = struct {\n    x: i32,\n};\n\npub fn main() void {}\n")

    assert {"Point", "main"} <= {c.name for c in chunks if c.name}


def test_haskell_declarations_container_is_expanded() -> None:
    """Haskell nests every top-level declaration inside one `declarations` node.

    Without expanding it, a module of any size is a single chunk, which is the
    namespace problem in a different grammar.
    """
    source = "module App where\n\ndata Shape = Rect Double\n\narea :: Int -> Int\narea x = x\n"
    named = {c.name for c in chunk_source("a.hs", source) if c.name}

    assert {"Shape", "area"} <= named


def test_lua_function_valued_bindings_are_named() -> None:
    """The arrow-function trap, in Lua.

    `M.area = function(w) ... end` is how a large share of real Lua defines its
    functions, and it shares a node type with `local x = 1`. Matching only
    `function_declaration` missed 263 of them in a single mid-sized plugin, all
    landing in module text unnamed, which lifted that repository's named
    fraction from 47.8% to 55.7% once handled.
    """
    assert [c.name for c in chunk_source("a.lua", "M.area = function(w)\n  return w\nend\n")] == ["M.area"]
    assert [c.name for c in chunk_source("a.lua", "local f = function(w)\n  return w\nend\n")] == ["f"]


def test_lua_constants_are_not_mistaken_for_functions() -> None:
    """Keeps the test above honest: the value, not the node type, decides."""
    for source in ("local x = 1\n", 'local M = require("plenary")\n'):
        chunks = chunk_source("a.lua", source)
        assert all(c.name is None for c in chunks), source
        assert all(c.kind == "module" for c in chunks), source


def test_oversized_definitions_split_at_their_members() -> None:
    """A class too large to stand as one chunk is cut at its methods.

    The alternative is `_split_oversized` cutting at a character count, which
    lands mid-method and produces fragments that embed as neither one thing nor
    the other. Names carry the enclosing type so retrieval keeps it.
    """
    body = "".join(
        f"    public void method{i}() {{\n" + f"        int x{i} = {i};\n" * 20 + "    }\n"
        for i in range(8)
    )
    chunks = chunk_source("W.java", f"public class Widget {{\n{body}}}\n")
    names = [c.name for c in chunks]

    assert "Widget.method0" in names
    assert "Widget.method7" in names
    assert all(len(c.text) <= MAX_CHUNK_CHARS for c in chunks)


def test_a_class_that_fits_is_left_whole() -> None:
    """Subdivision applies only when a definition is oversized.

    Keeping the unit of retrieval as large as it usefully can be is the point,
    and this is what makes the change additive rather than a rewrite of every
    existing language's output.
    """
    chunks = chunk_source("app/sample.py", PY_SOURCE)
    greeter = next(c for c in chunks if c.name == "Greeter")

    assert "def __init__" in greeter.text and "def greet" in greeter.text


def test_markdown_sections_subdivide_at_headings() -> None:
    """Markdown nests: `##` is a child of `#`, so a document is one section.

    Without subdivision a long document is a single chunk sliced at the
    character budget, which is worse than the fixed windows it replaced.
    """
    source = "# Guide\n\n" + ("introductory prose. " * 30) + "\n\n" + "".join(
        f"## Section {i}\n\n" + ("body prose for this section. " * 30) + "\n\n"
        for i in range(4)
    )
    assert len(source) > MAX_CHUNK_CHARS, "sample must be oversized to subdivide"
    names = [c.name for c in chunk_source("guide.md", source)]

    assert "Guide.Section 0" in names
    assert "Guide.Section 3" in names


def test_config_keys_are_named_without_their_quoting() -> None:
    """JSON keys are string literals; the quotes are syntax, not the name."""
    assert [c.name for c in chunk_source("a.json", '{\n  "name": "liffy"\n}\n')] == ["name"]
    assert [c.name for c in chunk_source("a.yml", "name: CI\n")] == ["name"]


def test_dockerfile_indexes_stages_not_steps() -> None:
    """`RUN` and `COPY` are steps inside a stage, not definitions.

    Registering them would make every line of the file its own chunk, which is
    the bash `command` mistake in another grammar.
    """
    source = "FROM node:20 AS builder\nRUN npm ci\nCOPY . .\n\nFROM nginx AS runtime\n"
    named = [c.name for c in chunk_source("Dockerfile.dockerfile", source) if c.name]

    assert named == ["builder", "runtime"]


def test_a_grammar_that_will_not_load_degrades_to_windows() -> None:
    """A registered grammar whose package is missing must not abort the run.

    Grammar packages are per-platform wheels and not every one is published for
    every platform: `tree-sitter-dockerfile` 0.2.0 ships macOS arm64 and Linux
    x86_64 only, with no source distribution, so it cannot be installed in an
    arm64 Linux container. Before this the indexer raised `ImportError` on the
    first such file and lost the whole repository's run.

    Asserted through the registry rather than by uninstalling a package, so the
    test holds on every platform including the ones where the grammar loads.
    """
    from app.services import chunker

    def explode():
        raise ImportError("no module named tree_sitter_nonexistent")

    original = dict(chunker._LANGUAGES)
    chunker._LANGUAGES[".broken"] = ("python", explode)
    chunker._DEFINITION_TYPES.setdefault("python", frozenset())
    try:
        chunker._parsers.pop(".broken", None)
        chunker._unavailable.discard(".broken")

        chunks = chunker.chunk_source("a.broken", "def hello():\n    pass\n")

        assert chunks, "the file must still be indexed, as fixed windows"
        assert all(c.kind == "block" for c in chunks)
        assert ".broken" in chunker._unavailable, "the failure must be recorded once"
    finally:
        chunker._LANGUAGES.clear()
        chunker._LANGUAGES.update(original)
        chunker._parsers.pop(".broken", None)
        chunker._unavailable.discard(".broken")


# ── #282: coverage, filenames, and range sanity ──────────────────────────────


def _oversized_java_class() -> str:
    """A class over MAX_CHUNK_CHARS, so `_subdivide` runs, with a field and a
    doc comment sitting *between* two methods and a constant after the last."""
    pad = "int x = 0; " * 220
    return (
        "public class Big {\n"
        f"  void method0() {{ {pad} }}\n"
        "  /** Returns the width. */\n"
        "  private int width;\n"
        f"  void method1() {{ {pad} }}\n"
        "  static final int TAIL = 7;\n"
        "}\n"
    )


def test_text_between_members_reaches_a_chunk() -> None:
    """Silent data loss, and the worst failure this component has.

    `_subdivide` emitted a header and one chunk per member. Anything between two
    members — a field, a doc comment, an annotation — was inside the class node
    and outside every member's byte range, so it reached no chunk at all.
    Nothing errored, the chunk count looked reasonable, and a search for the
    field simply returned nothing.
    """
    joined = "\n".join(c.text for c in chunk_source("Big.java", _oversized_java_class()))

    assert "private int width" in joined
    assert "Returns the width" in joined


def test_text_after_the_last_member_reaches_a_chunk() -> None:
    """The tail has the same hole. Usually just `}`, which is dropped as
    whitespace — but a trailing constant lives there too."""
    joined = "\n".join(c.text for c in chunk_source("Big.java", _oversized_java_class()))

    assert "TAIL" in joined


def test_a_gap_of_only_punctuation_produces_no_chunk() -> None:
    """The common gap must stay free.

    Members separated by nothing but a newline and a brace would otherwise emit
    a chunk per gap, doubling the index for no retrievable content.
    """
    pad = "int x = 0; " * 220
    java = (
        "public class Tight {\n"
        f"  void a() {{ {pad} }}\n"
        f"  void b() {{ {pad} }}\n"
        "}\n"
    )
    texts = [c.text for c in chunk_source("Tight.java", java)]

    assert not [t for t in texts if not t.strip()]
    # header + two members, and no gap chunk between them.
    assert len(texts) == 3


def test_no_chunk_ever_has_end_line_before_start_line() -> None:
    """A blanket invariant, over every shape in this file's fixtures.

    The header chunk ended on `members[0].start_point[0]` with no `+ 1` — right
    when the first member is on a later line, and `end_line=0` against
    `start_line=1` when the node and its first member start on the same row.
    A minified single-line document hit it. An `end_line` of 0 is not a line,
    and anything computing `end - start` gets a negative span.

    Asserted across every input rather than only the one that reproduced it,
    because the next such case will come from a shape nobody predicted.
    """
    inner = "".join(f'<div class="row-{i}">cell {i} padding</div>' for i in range(400))
    cases = {
        "minified.html": f"<html><body>{inner}</body></html>",
        "Big.java": _oversized_java_class(),
        "a.py": PY_SOURCE,
        "one.json": "{" + ",".join(f'"k{i}":"{"v" * 40}"' for i in range(200)) + "}",
        "Dockerfile": "FROM x AS a\nRUN y\n\nFROM x AS b\nRUN z\n",
    }

    for name, source in cases.items():
        for chunk in chunk_source(name, source):
            assert chunk.end_line >= chunk.start_line, (
                f"{name}: {chunk.start_line}-{chunk.end_line}"
            )
            assert chunk.start_line >= 1, f"{name}: start_line {chunk.start_line}"


def test_an_extensionless_convention_filename_resolves_to_its_grammar() -> None:
    """`Dockerfile` is the name almost every repository uses.

    The extension lookup needs a dot, so the canonical spelling resolved to `""`
    and fell back to fixed line windows — while `build.dockerfile` got the full
    grammar. The Dockerfile support that #261 added never fired for the common
    case.
    """
    source = "FROM python:3.11-slim AS builder\nRUN pip install x\n"

    by_name = chunk_source("Dockerfile", source)
    by_extension = chunk_source("build.dockerfile", source)

    assert [(c.kind, c.name) for c in by_name] == [
        (c.kind, c.name) for c in by_extension
    ]
    assert any(c.name == "builder" for c in by_name)


def test_a_convention_name_with_a_suffix_resolves_too() -> None:
    """`Dockerfile.prod` and `Dockerfile.dev` are the same file with a label."""
    source = "FROM python:3.11-slim AS builder\nRUN pip install x\n"

    assert any(c.name == "builder" for c in chunk_source("docker/Dockerfile.prod", source))


def test_a_real_extension_is_never_overridden_by_a_convention_stem() -> None:
    """A file whose stem collides with a convention name but which carries a
    genuine extension keeps that extension's grammar."""
    chunks = chunk_source("gemfile.py", "def f():\n    return 1\n")

    assert [c.kind for c in chunks] == ["function"]


def test_filename_map_only_points_at_registered_grammars() -> None:
    """A name mapped to a key with no grammar is not support — it is the same
    silent fallback as before, dressed up to look like support.

    This is what keeps `Makefile` and `Jenkinsfile` out until the grammars
    exist, rather than being listed and quietly doing nothing.
    """
    for name, key in _FILENAMES.items():
        assert key in _LANGUAGES, f"{name} -> {key} is not a registered grammar"
