"""Lexical search over Liffy's own documentation (#237).

**There is no model here, and that is the feature.** A help bot that answers
questions about Liffy has to be right about Liffy, and the failure mode of a
generative one is a confident, plausible, wrong answer about the very tool the
person is already struggling with. This returns passages a human wrote, ranked
by BM25, or it says it has nothing. It cannot invent an answer because it never
composes one.

Consequences worth knowing before changing anything here:

- No embeddings, no Chroma collection, no ONNX download, no API key. The index
  is built from ``app/help/*.md`` at import and lives in memory — about 15
  documents, so this is measured in milliseconds and kilobytes.
- It matches *words*, not meaning. Someone asking "my PR isn't getting looked
  at" will not reach the "queued vs processing" page unless the corpus says
  those words. The corpus carries the burden the model would have: aliases are
  how you teach it vocabulary.
- The relevance floor is load-bearing. Below it the honest answer is "nothing
  matched", and returning the least-bad passage instead is how a search box
  starts lying.

The ranking is ported from the retrieval engine in the author's portfolio
(``src/core/liffy/retrieval.ts``), which solved this problem for a corpus of
the same shape and size. The conversational half of that engine — clarify
loops, anaphora, follow-up memory — is deliberately left behind: this is a
search box, not a chat.
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass, field

# ── Tuning ────────────────────────────────────────────────────────────────────
#
# Carried over from the reference implementation, which tuned them against a
# corpus of this size and shape. Re-tune against `tests/test_help_service.py`'s
# query table if you change the corpus substantially — the off-topic cases in
# it are what stop the floor drifting down until everything matches something.

K1 = 1.4  # BM25 term-frequency saturation
B = 0.72  # BM25 length normalisation
ALIAS_WEIGHT = 2.4  # a heading-keyword hit is a strong, authored signal
PHRASE_BONUS = 3.0  # a distinctive multi-word title appears verbatim
PRIORITY_BONUS = 4.0  # `alias!` — this page owns the term when several match
IDF_FLOOR = 0.75  # one match this telling can answer alone…
IDF_SUM_FLOOR = 1.2  # …or several weaker ones must add up to this
MAX_RESULTS = 6  # the left pane is a list, not a search-engine page

_STOPWORDS = frozenset(
    """
    a an the is are was were be been being do does did of to in on for and or
    but with at by from as it its this that these those i you he she they we
    me him her them his your my our their what which who whom how when where
    why can could would should will shall have has had about tell know any
    some into so u get got give us please hey im there here if then than
    """.split()
)


def _stem(token: str) -> str:
    """Conservative suffix stripping, so "review"/"reviews"/"reviewing" collapse.

    Short tokens are left alone: Liffy's vocabulary is full of them ("pr",
    "env", "api", "cli"), and stemming those does more damage than good.
    """
    if len(token) <= 3:
        return token
    if token.endswith("ies"):
        return token[:-3] + "y"
    if token.endswith("ing") and len(token) > 5:
        return token[:-3]
    if token.endswith("ed") and len(token) > 4:
        return token[:-2]
    if token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


# Hyphens and underscores split. "re-run" has to become ["re", "run"] to reach
# the page whose aliases say "rerun" and "run again"; kept whole it is a token
# the corpus has never seen and never will.
_SPLIT_RE = re.compile(r"[^a-z0-9+#.]+")


def _tokenize(text: str) -> list[str]:
    tokens = []
    for raw in _SPLIT_RE.split(text.lower()):
        token = raw.strip("._-")
        if len(token) <= 1 or token in _STOPWORDS:
            continue
        stemmed = _stem(token)
        # "whats" stems to "what" — a stopword only after stemming.
        if stemmed in _STOPWORDS:
            continue
        tokens.append(stemmed)
    return tokens


_NORM_RE = re.compile(r"[^a-z0-9]+")


def _normalize(text: str) -> str:
    """Alphanumeric, single-spaced — for whole-phrase substring matching."""
    return _NORM_RE.sub(" ", text.lower()).strip()


def _pad(text: str) -> str:
    return f" {text} "


def _edit_distance(a: str, b: str, budget: int) -> int:
    """Damerau-Levenshtein, abandoned once the whole row exceeds ``budget``.

    Transpositions count as one edit, not two, because the common typo is a
    swap: "quened" for "queued" should be one keystroke away, not two.
    """
    if abs(len(a) - len(b)) > budget:
        return budget + 1

    prev2: list[int] | None = None
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        curr = [i]
        row_min = i
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            value = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
            if prev2 is not None and i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                value = min(value, prev2[j - 2] + 1)
            curr.append(value)
            row_min = min(row_min, value)
        if row_min > budget:
            return budget + 1
        prev2, prev = prev, curr
    return prev[len(b)]


# ── The corpus ────────────────────────────────────────────────────────────────

_MARKDOWN_NOISE = [
    (re.compile(r"```.*?```", re.S), " "),  # fenced code — not prose
    (re.compile(r"`([^`]*)`"), r"\1"),
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), " "),
    (re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"),
    (re.compile(r"^\s{0,3}#{1,6}\s*", re.M), ""),
    (re.compile(r"[*_]{1,3}([^*_]+)[*_]{1,3}"), r"\1"),
    (re.compile(r"^\s{0,3}>\s?", re.M), ""),
    (re.compile(r"\n{3,}"), "\n\n"),
]


def _strip_markdown(text: str) -> str:
    for pattern, replacement in _MARKDOWN_NOISE:
        text = pattern.sub(replacement, text)
    return text.strip()


class HelpCorpusError(ValueError):
    """A document is malformed. Raised at import, so CI catches it, not a user."""


@dataclass
class HelpDoc:
    """One page of the corpus: one question, answered."""

    slug: str
    title: str
    body: str
    """Rendered as markdown by the client — the reading pane shows all of it."""

    related: list[str]
    figure: str
    """Names a diagram the client draws, or "" for none.

    A *name*, never markup. The corpus says which illustration belongs to a
    page; the drawing lives in the frontend, so a document can never become a
    vector for markup on an endpoint that needs no session.
    """

    aliases: list[str]
    """Normalised phrases the author says this page answers to."""

    alias_tokens: set[str] = field(default_factory=set)
    priority_tokens: set[str] = field(default_factory=set)
    """From an alias marked `word!` — this page owns that word on a tie."""

    name_phrases: list[str] = field(default_factory=list)
    tf: dict[str, int] = field(default_factory=dict)
    length: int = 0


@dataclass
class HelpMatch:
    doc: HelpDoc
    score: float
    snippet: str


_FRONT_MATTER_RE = re.compile(r"\A---\n(.*?)\n---\n(.*)\Z", re.S)


def _parse_front_matter(raw: str, source: str) -> tuple[dict[str, str], str]:
    """Three keys and a body. Hand-parsed rather than pulling in a YAML dep.

    Deliberately strict: a typo'd key or a missing block raises instead of
    silently producing a document nobody can find. `test_corpus_parses` runs
    this over every file, so the failure lands in CI rather than in a search
    that quietly returns nothing.
    """
    match = _FRONT_MATTER_RE.match(raw.replace("\r\n", "\n"))
    if not match:
        raise HelpCorpusError(
            f"{source}: missing front matter. Every help document starts with a "
            f"`---` block holding title / aliases / related."
        )

    meta: dict[str, str] = {}
    for line_number, line in enumerate(match.group(1).split("\n"), start=2):
        if not line.strip():
            continue
        if ":" not in line:
            raise HelpCorpusError(f"{source}:{line_number}: expected `key: value`, got {line!r}")
        key, _, value = line.partition(":")
        meta[key.strip().lower()] = value.strip()

    unknown = set(meta) - {"title", "aliases", "related", "figure"}
    if unknown:
        raise HelpCorpusError(f"{source}: unknown front-matter key(s): {', '.join(sorted(unknown))}")
    for required in ("title", "aliases"):
        if not meta.get(required):
            raise HelpCorpusError(f"{source}: `{required}` is required and must not be empty")

    return meta, match.group(2).strip()


def _build_doc(slug: str, raw: str, source: str) -> HelpDoc:
    meta, body = _parse_front_matter(raw, source)
    if not body:
        raise HelpCorpusError(f"{source}: has front matter but no body")

    raw_aliases = [a.strip() for a in meta["aliases"].split("/") if a.strip()]
    priority_tokens: set[str] = set()
    aliases: list[str] = []
    for alias in raw_aliases:
        # Detect the `!` before normalising strips the punctuation.
        if alias.endswith("!"):
            priority_tokens.update(_tokenize(_normalize(alias)))
        normalised = _normalize(alias)
        if normalised and normalised not in aliases:
            aliases.append(normalised)

    prose = _strip_markdown(body)
    tf: dict[str, int] = {}
    length = 0
    for token in _tokenize(prose):
        tf[token] = tf.get(token, 0) + 1
        length += 1

    return HelpDoc(
        slug=slug,
        title=meta["title"],
        body=body,
        related=[r.strip() for r in meta.get("related", "").split(",") if r.strip()],
        figure=meta.get("figure", ""),
        aliases=aliases,
        alias_tokens=set().union(*(set(_tokenize(a)) for a in aliases)) if aliases else set(),
        priority_tokens=priority_tokens,
        # Multi-word aliases only. A single word is a facet ("queued"), and
        # granting it the verbatim-title bonus on top of its alias weight
        # double-counts it into beating the page that is actually about it.
        name_phrases=[a for a in aliases if " " in a],
        tf=tf,
        length=length,
    )


class HelpIndex:
    """An in-memory BM25 index over the help corpus.

    Built once at import. There is no invalidation because the corpus ships
    with the code — editing a document means a deploy, which is the right
    coupling for text that documents that exact deploy.
    """

    def __init__(self, docs: list[HelpDoc]) -> None:
        self.docs = docs
        self._idf: dict[str, float] = {}
        self._vocab: list[tuple[str, float]] = []
        self.avgdl = 1.0

        if not docs:
            return

        df: dict[str, int] = {}
        total_length = 0
        for doc in docs:
            total_length += doc.length
            # The heading keywords count as part of the document, so an alias
            # nobody wrote in the prose still makes the page findable.
            for token in set(doc.tf) | doc.alias_tokens:
                df[token] = df.get(token, 0) + 1

        n = len(docs)
        for token, count in df.items():
            self._idf[token] = math.log(1 + (n - count + 0.5) / (count + 0.5))
        self.avgdl = total_length / n or 1.0

        # Typos are corrected onto *authored* vocabulary only — the alias
        # tokens — never onto a word that merely appears in some page's prose.
        #
        # This is the difference between a helpful correction and a fabricated
        # one. "world" is one edit from "word", which occurs incidentally in
        # settings-and-env ("the page is the last word"), so a body-wide
        # vocabulary turned "who won the world cup" into a settings result.
        # Aliases are the words an author deliberately said this corpus knows,
        # which is exactly the set worth guessing towards.
        alias_vocab = {t for doc in docs for t in doc.alias_tokens}
        self._vocab = [
            (t, v) for t, v in self._idf.items() if t in alias_vocab and len(t) >= 4 and v >= 0.5
        ]

    def _correct(self, token: str) -> str | None:
        """Map a typo onto the nearest telling vocabulary term.

        Requires the first letter to match: typos rarely change it, and without
        that constraint short real words drift into other real words.

        The length gate is 4, not 5, because this runs on *stemmed* tokens.
        "queued" stems to "queu" and the typo "quened" to "quen" — both four
        characters, one edit apart, and a gate of 5 skipped the correction
        entirely. Judging a stem by the length of the word someone typed is the
        mistake; there is nothing else here to judge.
        """
        if len(token) < 4:
            return None
        budget = 2 if len(token) >= 7 else 1
        best: tuple[str, int, float] | None = None
        for candidate, idf in self._vocab:
            if candidate[0] != token[0]:
                continue
            distance = _edit_distance(token, candidate, budget)
            if distance > budget:
                continue
            if best is None or distance < best[1] or (distance == best[1] and idf > best[2]):
                best = (candidate, distance, idf)
        return best[0] if best else None

    def _score(
        self, doc: HelpDoc, terms: list[str], norm: str
    ) -> tuple[float, int, float, float, bool]:
        score = 0.0
        matched = 0
        best_idf = 0.0
        idf_sum = 0.0
        authored = False
        """A `!` alias or a verbatim multi-word title — an author's ruling.

        These clear the relevance floor on their own. The floor measures how
        *telling* a word is across the corpus, which is the wrong question for
        a word the author explicitly assigned to a page: "provider" appears in
        a dozen documents, so its IDF sits under the floor, and a search for
        "providers" returned nothing at all while `provider!` sat in the
        providers page's aliases saying exactly where it should go.
        """

        for term in terms:
            idf = self._idf.get(term, 0.0)
            freq = doc.tf.get(term, 0)
            tf_part = (
                0.0
                if freq == 0
                else (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * (doc.length / self.avgdl)))
            )
            body_score = idf * tf_part
            alias_score = idf * ALIAS_WEIGHT if term in doc.alias_tokens else 0.0
            priority_score = 0.0
            if term in doc.priority_tokens:
                priority_score = PRIORITY_BONUS
                authored = True

            if body_score > 0 or alias_score > 0:
                matched += 1
                idf_sum += idf
                best_idf = max(best_idf, idf)
            score += body_score + alias_score + priority_score

        padded = _pad(norm)
        for phrase in doc.name_phrases:
            if _pad(phrase) in padded:
                score += PHRASE_BONUS
                authored = True

        return score, matched, best_idf, idf_sum, authored

    def search(self, query: str) -> list[HelpMatch]:
        """Ranked passages, or an empty list when nothing is a real answer.

        The empty list is a *result*, not a failure. "Nothing matched" is the
        correct answer to a question the corpus does not cover, and the caller
        renders it as such.
        """
        raw_terms = _tokenize(query)
        if not raw_terms:
            return []

        # Correct only what the corpus has never seen — a word that is already
        # in the vocabulary is not a typo, however close it sits to another.
        terms = [t if t in self._idf else (self._correct(t) or t) for t in raw_terms]
        norm = _normalize(query)

        scored = []
        for doc in self.docs:
            score, matched, best_idf, idf_sum, authored = self._score(doc, terms, norm)
            if score <= 0:
                continue
            # The floor: an authored claim on the word, one telling term, or
            # several that add up. Without it every query matches whatever page
            # happens to say "review".
            if not (
                authored
                or best_idf >= IDF_FLOOR
                or (matched >= 2 and idf_sum >= IDF_SUM_FLOOR)
            ):
                continue
            scored.append(HelpMatch(doc=doc, score=score, snippet=_snippet(doc)))

        scored.sort(key=lambda m: (-m.score, m.doc.title))
        return scored[:MAX_RESULTS]


def _snippet(doc: HelpDoc, limit: int = 180) -> str:
    """The opening of the page, for the list pane.

    Deliberately not the matched sentence. The list is a table of contents —
    every row reading the same way makes it scannable, whereas rows that each
    open mid-thought at a different keyword do not.
    """
    prose = " ".join(_strip_markdown(doc.body).split())
    if len(prose) <= limit:
        return prose
    cut = prose[:limit]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit * 0.6 else cut).rstrip(",;:.") + "…"


# ── Loading ───────────────────────────────────────────────────────────────────

CORPUS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "help")
"""``backend/app/help``.

Under the package, not the repo's top-level `docs/`, because the API serves
this and the image is built from `backend/` alone — a corpus at the repo root
would be readable in development and absent in Docker, which is the worst of
both.
"""


def load_corpus(directory: str = CORPUS_DIR) -> list[HelpDoc]:
    if not os.path.isdir(directory):
        return []
    docs = []
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".md") or name == "README.md":
            continue
        path = os.path.join(directory, name)
        with open(path, encoding="utf-8") as handle:
            docs.append(_build_doc(name[:-3], handle.read(), f"app/help/{name}"))
    return docs


_index: HelpIndex | None = None


def get_index() -> HelpIndex:
    """The process-wide index, built on first use.

    Lazy rather than at import so a malformed document fails the request that
    needs it — and the test that parses the corpus — instead of preventing the
    whole API from starting.
    """
    global _index
    if _index is None:
        _index = HelpIndex(load_corpus())
    return _index


def search(query: str) -> list[HelpMatch]:
    return get_index().search(query)
