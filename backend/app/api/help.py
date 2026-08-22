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

from app.api.deps import require_owner
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
    GitHubAuthError,
    GitHubClient,
    GitHubError,
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
    user: User = Depends(require_owner),
) -> ReportOut:
    """File a bug or a feature idea as a GitHub issue, and return where it went.

    **Owner only**, unlike the rest of this router. Reading the docs needs no
    session; writing to a public issue tracker does. Without that gate a Liffy
    instance reachable from the internet is an anonymous issue-posting endpoint
    aimed at someone else's repository.

    Authentication alone was not enough for that, and this is the sharper half:
    the issue is filed with the *instance's* token, so before sign-up was
    closed, any stranger with a GitHub account could post to `lucenity0/Liffy`
    under the maintainer's name. `require_owner` means the account that files
    the issue is the account the token belongs to.

    **Filed as the person reporting it**, using their own OAuth token rather
    than an instance PAT. The issue's GitHub author is therefore the reporter:
    they get the notifications, they can answer follow-ups in the thread as
    themselves, and "who reported this" is the byline rather than a line of
    prose in the body claiming it.

    That claim used to be exactly what this did — append "Reported by @x",
    because the issue carried the PAT owner's name and the real reporter was
    otherwise lost. The workaround existed because the wrong account was
    filing. Using the right account deletes both the workaround and the only
    reason this install needed `GITHUB_TOKEN` at all.

    The scope is already there: sign-in requests `repo,read:user`, and opening
    an issue on a public repository needs considerably less than that.

    Security reports cannot reach here — `ReportIn` has no shape for one. They
    go to a private advisory, per `SECURITY.md`.
    """
    owner, repo = LIFFY_REPO
    label = "enhancement" if payload.kind == "feature" else "bug"

    # Where it came from, and nothing about who — the byline carries that now.
    # Worth keeping even so: an issue typed into Liffy's form and one typed on
    # GitHub read identically otherwise, and knowing which is which is the one
    # piece of metadata the author field cannot supply.
    body = f"{payload.body.strip()}\n\n---\nFiled from Liffy's in-app help."

    try:
        with GitHubClient(token=user.github_access_token) as client:
            issue = client.create_issue(owner, repo, payload.title.strip(), body, [label])
    except GitHubAuthError as exc:
        # Before the broader clause, because `GitHubAuthError` is a subclass and
        # an `except` chain in the other order would never reach it — the same
        # ordering `api/repos.py` and `api/reviews.py` already spell out.
        #
        # 503 rather than 502, and the difference is the whole point here. 502
        # means "GitHub refused"; this is Liffy having no credential to ask
        # with, which is a local misconfiguration nobody at GitHub can help
        # with. `GITHUB_TOKEN` is the only thing this route needs a PAT for —
        # every other caller acts as the signed-in user — so on an install that
        # never set one, "Report a problem" is the single feature that breaks,
        # and it breaks silently until somebody tries to report a problem.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except GitHubError as exc:
        # 502, not 500: Liffy is fine, GitHub refused. The message carries
        # through so "your token cannot write to that repository" reaches the
        # person who can fix it instead of a generic failure.
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return ReportOut(number=issue["number"], url=issue["html_url"])
