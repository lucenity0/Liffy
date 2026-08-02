"""Help search (#237).

**Unauthenticated, deliberately.** Every other route here is gated because it
reaches a user's repositories, reviews or credentials. This one serves fifteen
markdown files that ship in the image and are published in the repository
anyway — gating them would only mean that the person most likely to need
"why can't I sign in?" is the one person who cannot read it.

Nothing user-specific is reachable through it. It takes a string, ranks static
documents, and returns their text.
"""

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import get_current_user
from app.models.user import User
from app.schemas.help import (
    HelpIndexOut,
    HelpLink,
    HelpPassage,
    HelpSearchOut,
    HelpTopic,
    ReportIn,
    ReportOut,
)
from app.services.github_service import (
    GitHubClient,
    GitHubError,
    get_github_token,
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


LIFFY_REPO = ("lucenity0", "Liffy")
"""Where reports go. Liffy's own repository, not the user's.

Hardcoded rather than configurable: a report is about Liffy, and pointing it at
the repository being reviewed would file "your help search is broken" against
somebody's unrelated codebase.
"""


@router.post("/help/report", response_model=ReportOut, status_code=201)
def submit_report(
    payload: ReportIn,
    user: User = Depends(get_current_user),
) -> ReportOut:
    """File a bug or a feature idea as a GitHub issue, and return where it went.

    **Authenticated**, unlike the rest of this router. Reading the docs needs no
    session; writing to a public issue tracker does. Without that gate a Liffy
    instance reachable from the internet is an anonymous issue-posting endpoint
    aimed at someone else's repository.

    The issue is filed with the instance's own GitHub token, so it is attributed
    to whoever owns that token rather than to the person typing. On a self-hosted
    install those are usually the same person; where they are not, the body says
    so rather than leaving the attribution silently wrong.

    Security reports cannot reach here — `ReportIn` has no shape for one. They
    go to a private advisory, per `SECURITY.md`.
    """
    owner, repo = LIFFY_REPO
    label = "enhancement" if payload.kind == "feature" else "bug"

    # Says who actually typed it, since the issue will carry the token owner's
    # name. Only the GitHub login — nothing else about the account, and nothing
    # about the instance.
    body = (
        f"{payload.body.strip()}\n\n---\n"
        f"Reported by @{user.username} from Liffy's in-app help."
    )

    try:
        with GitHubClient(get_github_token()) as client:
            issue = client.create_issue(owner, repo, payload.title.strip(), body, [label])
    except GitHubError as exc:
        # 502, not 500: Liffy is fine, GitHub refused. The message carries
        # through so "your token cannot write to that repository" reaches the
        # person who can fix it instead of a generic failure.
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return ReportOut(number=issue["number"], url=issue["html_url"])
