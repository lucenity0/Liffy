"""Retrieval quality for the help corpus (#237).

Two kinds of test here, and the second kind matters more.

The first asserts that known questions reach the page that answers them. Those
break when the corpus changes, which is correct — they are the contract between
the wording of a question and the aliases of a page.

The second asserts that questions the corpus does *not* cover return **nothing**.
That is the whole honesty guarantee: a lexical search with no floor always has a
best match, and returning it is how a help box starts confidently answering
questions about Kubernetes. If a change makes the off-topic cases start matching,
the floor has drifted and the fix is the floor, not the test.
"""

import pytest

from app.services import help_service as H

# Real questions, in the words someone would actually type — including the
# vocabulary of a person who is stuck, which is rarely the codebase's.
ANSWERABLE = [
    ("why is my review queued", "review-states"),
    ("review stuck nothing happening", "review-states"),
    ("my review failed", "review-failed"),
    ("claude is not on PATH", "subscription-providers"),
    ("should i reindex after every merge", "reindex-after-merge"),
    ("what does indexing do", "indexing"),
    ("where does my code go", "where-your-code-goes"),
    ("how do i use my claude subscription", "subscription-providers"),
    ("run a local model", "ollama"),
    ("how do i disconnect a token", "connect-a-credential"),
    ("pr didnt trigger a review", "webhooks"),
    ("rate limit", "rate-limits"),
    ("how do i report a bug", "report-a-problem"),
    ("how do i start liffy", "getting-started"),
    ("re-run a review", "re-review"),
]

# Nothing in Liffy's docs answers these. The floor must reject them outright.
OFF_TOPIC = [
    "how do i deploy to kubernetes",
    "what is the capital of france",
    "best pizza recipe",
    "tell me a joke",
    "who won the world cup",
    "what should i cook tonight",
]


@pytest.mark.parametrize("query,expected_slug", ANSWERABLE)
def test_a_real_question_reaches_the_page_that_answers_it(query: str, expected_slug: str) -> None:
    results = H.search(query)
    assert results, f"{query!r} matched nothing"
    assert results[0].doc.slug == expected_slug, (
        f"{query!r} ranked {results[0].doc.slug} first, expected {expected_slug}. "
        f"Full order: {[r.doc.slug for r in results]}"
    )


@pytest.mark.parametrize("query", OFF_TOPIC)
def test_an_unanswerable_question_returns_nothing(query: str) -> None:
    """The floor, which is the reason this feature is trustworthy at all."""
    assert H.search(query) == []


@pytest.mark.parametrize("query", ["", "   ", "?", "a", "the and of"])
def test_an_empty_or_stopword_only_query_returns_nothing(query: str) -> None:
    assert H.search(query) == []


def test_a_query_sharing_corpus_vocabulary_may_match_and_that_is_correct() -> None:
    """The documented limit of a lexical search, pinned so nobody "fixes" it.

    "write me a poem about databases" returns the settings page, because that
    page really does say "database" and this really is word matching. That is
    not the failure mode the floor exists to prevent: the user is shown a page
    a human wrote, clearly titled, and can see in one glance it is not what
    they asked for.

    The failure worth preventing is *invention* — an answer composed about a
    topic the corpus does not cover. That cannot happen here, because nothing
    composes anything. Tightening the floor until this case returns nothing
    would cost real recall on questions phrased in unusual words, which is the
    far more common event.
    """
    results = H.search("write me a poem about databases")
    assert results, "if this now returns nothing, the floor was raised — check recall"
    assert all(r.doc.title for r in results), "every result is still a real authored page"


@pytest.mark.parametrize(
    "typo,expected_slug",
    [
        ("quened", "review-states"),  # transposition-ish: one key off "queued"
        ("reindx after merge", "reindex-after-merge"),
        ("indexng", "indexing"),
        ("reprot a bug", "report-a-problem"),
    ],
)
def test_a_typo_still_finds_the_page(typo: str, expected_slug: str) -> None:
    """Someone mistyping a word is not someone asking a different question.

    Note these run against *stemmed* tokens — "queued" is indexed as "queu" —
    which is why the correction length gate is 4 rather than 5.
    """
    results = H.search(typo)
    assert results and results[0].doc.slug == expected_slug


def test_results_are_ordered_by_score() -> None:
    results = H.search("review failed provider")
    assert len(results) > 1
    assert [r.score for r in results] == sorted((r.score for r in results), reverse=True)


def test_no_more_than_the_cap_comes_back() -> None:
    """The left pane is a list, not a search-engine results page."""
    assert len(H.search("review")) <= H.MAX_RESULTS


# ── The corpus itself ─────────────────────────────────────────────────────────


def test_the_corpus_parses() -> None:
    """A malformed document should fail a pull request, not a user's search."""
    docs = H.load_corpus()
    assert len(docs) >= 10, "the corpus is the product; this looks like a loading bug"
    for doc in docs:
        assert doc.title and doc.body and doc.aliases
        assert doc.length > 0, f"{doc.slug} has no indexable prose"


def test_related_slugs_all_exist() -> None:
    """A dead `related:` link is a broken link in the UI."""
    docs = H.load_corpus()
    slugs = {d.slug for d in docs}
    for doc in docs:
        for related in doc.related:
            assert related in slugs, f"{doc.slug} points at missing page {related!r}"


def test_no_two_pages_claim_the_same_alias() -> None:
    """An alias owned by two pages ranks for both and wins convincingly for neither.

    `!` is the escape hatch: it marks the page that owns a genuinely contested
    word, and a word claimed that way is allowed to appear elsewhere.
    """
    owners: dict[str, str] = {}
    clashes = []
    for doc in H.load_corpus():
        for alias in doc.aliases:
            token = alias.strip()
            if token in owners and token not in doc.priority_tokens:
                clashes.append(f"{token!r}: {owners[token]} and {doc.slug}")
            owners.setdefault(token, doc.slug)
    assert not clashes, "aliases claimed twice — give the word to one page:\n" + "\n".join(clashes)


def test_the_readme_is_not_indexed() -> None:
    """`README.md` is the authoring guide, not an answer to anything."""
    assert "README" not in {d.slug for d in H.load_corpus()}


def test_a_malformed_document_names_the_file(tmp_path) -> None:
    (tmp_path / "broken.md").write_text("no front matter at all\n", encoding="utf-8")
    with pytest.raises(H.HelpCorpusError, match="broken.md"):
        H.load_corpus(str(tmp_path))


def test_a_document_with_an_unknown_key_is_rejected(tmp_path) -> None:
    """A typo'd key would otherwise be silently ignored, losing the aliases."""
    (tmp_path / "typo.md").write_text(
        "---\ntitle: X\naliases: x\nrelated: y\nalises: oops\n---\n\nBody.\n", encoding="utf-8"
    )
    with pytest.raises(H.HelpCorpusError, match="alises"):
        H.load_corpus(str(tmp_path))


def test_snippets_are_short_and_lead_with_the_answer() -> None:
    for doc in H.load_corpus():
        snippet = H._snippet(doc)
        assert len(snippet) <= 200
        assert not snippet.startswith("#")
