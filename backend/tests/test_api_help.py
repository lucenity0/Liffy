"""The help endpoints (#237).

`test_help_service.py` covers ranking. This covers the contract the frontend
depends on, plus the two decisions that are easy to reverse by accident: that
help is readable without a session, and that finding nothing is a 200.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_help_is_readable_without_a_session() -> None:
    """Deliberately public, and pinned so it is not "tightened" by reflex.

    Everything else in this API is gated because it reaches a user's
    repositories, reviews or credentials. Help reaches fifteen markdown files
    that ship in the image and are public in the repository. Gating them would
    mean the person who most needs "why can't I sign in?" is the one person who
    cannot read it.
    """
    for path in ("/help?q=queued", "/help/topics", "/help/review-states"):
        assert client.get(path).status_code == 200, path


def test_a_question_returns_ranked_passages() -> None:
    body = client.get("/help", params={"q": "why is my review queued"}).json()

    assert body["query"] == "why is my review queued"
    assert body["results"], "a known question returned nothing"
    top = body["results"][0]
    assert top["slug"] == "review-states"
    assert top["title"]
    assert top["snippet"]
    assert top["body"], "the reading pane needs the whole page, not just a snippet"


def test_nothing_matched_is_a_200_with_an_empty_list() -> None:
    """Not a 404. The search ran correctly and the answer is "we don't cover that".

    A 404 would say the endpoint does not exist, and the page would render its
    error boundary instead of the "Liffy's docs don't cover that" state that
    the empty list is there to produce.
    """
    response = client.get("/help", params={"q": "how do i deploy to kubernetes"})

    assert response.status_code == 200
    assert response.json()["results"] == []


def test_a_blank_query_returns_nothing_rather_than_everything() -> None:
    assert client.get("/help", params={"q": ""}).json()["results"] == []


def test_an_overlong_query_is_rejected_rather_than_scored() -> None:
    assert client.get("/help", params={"q": "x" * 5000}).status_code == 422


def test_topics_lists_common_questions_and_the_whole_corpus() -> None:
    body = client.get("/help/topics").json()

    assert len(body["common"]) >= 3
    assert len(body["all_topics"]) >= len(body["common"])
    assert all(t["slug"] and t["title"] for t in body["all_topics"])
    # Alphabetical by title: the list is a table of contents, and corpus file
    # order is not a property anyone asked to browse by.
    titles = [t["title"] for t in body["all_topics"]]
    assert titles == sorted(titles)
    common_slugs = {t["slug"] for t in body["common"]}
    all_slugs = {t["slug"] for t in body["all_topics"]}
    assert common_slugs <= all_slugs, "a common question points at a page that does not exist"


def test_a_page_can_be_fetched_by_slug_for_deep_links() -> None:
    body = client.get("/help/review-states").json()

    assert body["slug"] == "review-states"
    assert body["body"]
    assert all(link["slug"] and link["title"] for link in body["related"])


def test_an_unknown_slug_returns_null_rather_than_404() -> None:
    """A stale bookmark should land on the help page's own empty state.

    404 would route it to the app's error boundary, which is a heavier answer
    than "that page moved" deserves.
    """
    response = client.get("/help/no-such-page")

    assert response.status_code == 200
    assert response.json() is None


def test_the_corpus_is_never_authoring_notes() -> None:
    """`README.md` documents how to write pages; it is not an answer."""
    slugs = {t["slug"] for t in client.get("/help/topics").json()["all_topics"]}
    assert "README" not in slugs and "readme" not in slugs


def test_help_leaks_no_configuration() -> None:
    """The corpus talks *about* settings; it must not contain any.

    Cheap insurance on a public endpoint: if someone ever pastes a real token
    or connection string into a help page as an example, this fails.
    """
    raw = client.get("/help/topics").text
    for slug in {t["slug"] for t in client.get("/help/topics").json()["all_topics"]}:
        raw += client.get(f"/help/{slug}").text

    for marker in ("sk-ant-", "sk-proj-", "ghp_", "github_pat_", "postgresql://", "BEGIN PRIVATE KEY"):
        assert marker not in raw, f"the help corpus contains {marker!r}"
