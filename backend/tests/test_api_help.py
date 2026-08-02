"""The help endpoints (#237).

`test_help_service.py` covers ranking. This covers the contract the frontend
depends on, plus the two decisions that are easy to reverse by accident: that
help is readable without a session, and that finding nothing is a 200.
"""

import pytest
from conftest import auth_headers, seed_user
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import help as help_api
from app.database import Base, get_db
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


# ── Filing a report ───────────────────────────────────────────────────────────


class _FakeClient:
    """Stands in for GitHubClient. Records the call; never touches the network."""

    calls: list[dict] = []

    def __init__(self, *_a, **_k) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def create_issue(self, owner, repo, title, body, labels):
        _FakeClient.calls.append(
            {"owner": owner, "repo": repo, "title": title, "body": body, "labels": labels}
        )
        return {"number": 251, "html_url": "https://github.com/lucenity0/Liffy/issues/251"}


@pytest.fixture
def seeded():
    """A signed-in user, since filing a report needs a session."""
    engine = create_engine(
        "sqlite://", future=True, connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)

    with factory() as db:
        user = seed_user(db, github_id=1, username="octo")
        db.commit()
        headers = auth_headers(user)

    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    yield {"headers": headers}
    app.dependency_overrides.clear()


@pytest.fixture
def fake_github(monkeypatch):
    _FakeClient.calls = []
    monkeypatch.setattr(help_api, "GitHubClient", _FakeClient)
    monkeypatch.setattr(help_api, "get_github_token", lambda: "token")
    return _FakeClient


def test_reporting_requires_a_session(fake_github) -> None:
    """Reading help needs none; writing to a public tracker does.

    Without this an instance reachable from the internet is an anonymous
    issue-posting endpoint aimed at somebody else's repository.
    """
    response = client.post("/help/report", json={"title": "Something", "body": "x" * 20})

    assert response.status_code == 401
    assert fake_github.calls == []


def test_a_bug_report_files_a_labelled_issue(seeded, fake_github) -> None:
    response = client.post(
        "/help/report",
        headers=seeded["headers"],
        json={"title": "Reviews stay queued", "body": "They never start running."},
    )

    assert response.status_code == 201
    assert response.json() == {
        "number": 251,
        "url": "https://github.com/lucenity0/Liffy/issues/251",
    }
    call = fake_github.calls[0]
    assert call["labels"] == ["bug"]
    assert call["title"] == "Reviews stay queued"
    # Filed with the instance's token, so the issue would otherwise carry the
    # wrong name. The body says who actually typed it.
    assert "Reported by @" in call["body"]


def test_a_feature_idea_is_labelled_enhancement(seeded, fake_github) -> None:
    client.post(
        "/help/report",
        headers=seeded["headers"],
        json={
            "title": "Filter reviews by repository",
            "body": "Scrolling the whole list to find one repo's reviews.",
            "kind": "feature",
        },
    )

    assert fake_github.calls[0]["labels"] == ["enhancement"]


def test_a_security_report_cannot_be_expressed(seeded, fake_github) -> None:
    """The strongest form of "security reports do not become public issues".

    `SECURITY.md` says a public issue is readable by everyone, including whoever
    would use the bug, before there is a fix. Rather than validate that away,
    the request model has no shape for it — there is no `kind` that reaches
    GitHub with a vulnerability in it.
    """
    response = client.post(
        "/help/report",
        headers=seeded["headers"],
        json={"title": "Auth bypass", "body": "Here is how to forge a session.", "kind": "security"},
    )

    assert response.status_code == 422
    assert fake_github.calls == []


def test_reports_go_to_liffys_repository_not_the_users(seeded, fake_github) -> None:
    """A report is about Liffy. Filing it against the repo under review would
    put "your help search is broken" on somebody's unrelated codebase."""
    client.post(
        "/help/report",
        headers=seeded["headers"],
        json={"title": "A title", "body": "A body long enough."},
    )

    assert (fake_github.calls[0]["owner"], fake_github.calls[0]["repo"]) == ("lucenity0", "Liffy")


@pytest.mark.parametrize(
    "payload",
    [
        {"title": "ab", "body": "long enough body here"},
        {"title": "fine title", "body": "short"},
        {"title": "x" * 200, "body": "long enough body here"},
    ],
)
def test_a_malformed_report_is_rejected_before_github(seeded, fake_github, payload) -> None:
    assert client.post("/help/report", headers=seeded["headers"], json=payload).status_code == 422
    assert fake_github.calls == []


def test_github_refusing_reads_as_github_not_as_liffy(seeded, monkeypatch) -> None:
    """502, not 500 — and the reason travels, so "your token cannot write there"
    reaches the person who can fix it."""
    from app.services.github_service import GitHubError

    class _Refusing(_FakeClient):
        def create_issue(self, *_a, **_k):
            raise GitHubError("Resource not accessible by personal access token")

    monkeypatch.setattr(help_api, "GitHubClient", _Refusing)
    monkeypatch.setattr(help_api, "get_github_token", lambda: "token")

    response = client.post(
        "/help/report",
        headers=seeded["headers"],
        json={"title": "A title", "body": "A body long enough."},
    )

    assert response.status_code == 502
    assert "not accessible" in response.json()["detail"]
