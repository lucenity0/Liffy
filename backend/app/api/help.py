"""Help search (#237).

**Unauthenticated, deliberately.** Every other route here is gated because it
reaches a user's repositories, reviews or credentials. This one serves fifteen
markdown files that ship in the image and are published in the repository
anyway — gating them would only mean that the person most likely to need
"why can't I sign in?" is the one person who cannot read it.

Nothing user-specific is reachable through it. It takes a string, ranks static
documents, and returns their text.
"""

from fastapi import APIRouter, Query

from app.schemas.help import (
    HelpIndexOut,
    HelpLink,
    HelpPassage,
    HelpSearchOut,
    HelpTopic,
)
from app.services.help_service import HelpDoc, HelpMatch, get_index

router = APIRouter()

COMMON_QUESTIONS = (
    "review-states",
    "review-failed",
    "reindex-after-merge",
    "providers",
    "where-your-code-goes",
)
"""What the page offers before anything is typed.

Hand-picked rather than derived — "most linked" or "shortest" would order these
by a property nobody asked about. This is the list of things people actually
arrive confused about, and it doubles as the corpus's table of contents.
"""

MAX_QUERY_CHARS = 200
"""Longer than any real question.

Not a security boundary — scoring is linear in query terms over fifteen
documents, so a long string is slow in no interesting way. It is here so the
index cannot be used as a place to POST prose.
"""


def _links(doc: HelpDoc, titles: dict[str, str]) -> list[HelpLink]:
    # Silently drops a `related:` slug that no longer exists rather than
    # rendering a dead link. `test_related_slugs_all_exist` is what actually
    # stops that happening; this is the belt to its braces.
    return [
        HelpLink(slug=slug, title=titles[slug]) for slug in doc.related if slug in titles
    ]


def _passage(match: HelpMatch, titles: dict[str, str]) -> HelpPassage:
    return HelpPassage(
        slug=match.doc.slug,
        title=match.doc.title,
        snippet=match.snippet,
        body=match.doc.body,
        related=_links(match.doc, titles),
        figure=match.doc.figure,
        score=round(match.score, 3),
    )


@router.get("/help", response_model=HelpSearchOut)
def search_help(q: str = Query("", max_length=MAX_QUERY_CHARS)) -> HelpSearchOut:
    """Ranked passages for a question, or an empty list.

    An empty list is a result, not an error, and the status stays 200. A 404
    here would say "this endpoint does not exist" about a search that ran
    correctly and found nothing.
    """
    index = get_index()
    titles = {doc.slug: doc.title for doc in index.docs}
    return HelpSearchOut(
        query=q,
        results=[_passage(m, titles) for m in index.search(q)],
    )


@router.get("/help/topics", response_model=HelpIndexOut)
def list_help_topics() -> HelpIndexOut:
    """The empty state: common questions, and everything else that exists."""
    index = get_index()
    by_slug = {doc.slug: doc for doc in index.docs}
    return HelpIndexOut(
        common=[
            HelpTopic(slug=slug, title=by_slug[slug].title)
            for slug in COMMON_QUESTIONS
            if slug in by_slug
        ],
        all_topics=sorted(
            (HelpTopic(slug=d.slug, title=d.title) for d in index.docs),
            key=lambda t: t.title,
        ),
    )


@router.get("/help/{slug}", response_model=HelpPassage | None)
def get_help_page(slug: str) -> HelpPassage | None:
    """One page by slug — what a deep link into `/help` resolves.

    Returns null rather than 404 for an unknown slug so a stale bookmark lands
    on the help page's own "nothing here" state instead of the app's error
    boundary.
    """
    index = get_index()
    titles = {doc.slug: doc.title for doc in index.docs}
    doc = next((d for d in index.docs if d.slug == slug), None)
    if doc is None:
        return None
    return _passage(HelpMatch(doc=doc, score=0.0, snippet=""), titles)
