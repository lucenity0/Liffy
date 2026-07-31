import uuid
from datetime import datetime, timedelta, timezone

import pytest
from conftest import auth_headers, seed_user
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api import reviews as reviews_api
from app.database import Base, get_db
from app.main import app
from app.models.comment_feedback import CommentFeedback
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.review_comment import ReviewComment
from app.models.user import User

client = TestClient(app)

T0 = datetime(2026, 7, 1, tzinfo=timezone.utc)

RAW_DIFF = "diff --git a/a.py b/a.py\n@@ -1,2 +1,2 @@\n-old\n+new\n"


def _seed_reviews(db, user: User, full_name: str, summaries: tuple[str, str]) -> dict:
    """One repo + PR + two reviews (older, newer) owned by ``user``."""
    repo = Repository(user_id=user.id, github_repo_id=9, full_name=full_name)
    db.add(repo)
    db.flush()
    pr = PullRequest(
        repo_id=repo.id, github_pr_number=7, title="Fix", author="octo",
        base_branch="main", head_branch="fix", status="open",
    )
    db.add(pr)
    db.flush()
    # `old` stands in for a review written before METRIC-1 landed: every §8.1
    # column NULL. Every row already in a real database looks like this, so it
    # is worth having one in the fixture rather than only in one test. It now
    # covers five NULLs rather than three — METRIC-2's two columns are exactly
    # as absent from a legacy row as METRIC-1's were.
    old = Review(pr_id=pr.id, status="completed", summary=summaries[0], verdict="approve",
                 created_at=T0)
    new = Review(pr_id=pr.id, status="completed", summary=summaries[1], verdict="comment",
                 model_used="m", tokens_used=20, duration_ms=1234,
                 queued_at=T0 + timedelta(hours=1) - timedelta(seconds=5), total_ms=6234,
                 created_at=T0 + timedelta(hours=1), raw_diff=RAW_DIFF)
    db.add_all([old, new])
    db.flush()
    comment = ReviewComment(
        review_id=new.id, file_path="a.py", line_start=1, line_end=2,
        category="logic_error", severity="warning", comment_text="Bug.", suggestion=None,
    )
    db.add(comment)
    db.flush()
    return {
        "repo": repo.id, "pr": pr.id, "old": old.id, "new": new.id, "comment": comment.id,
    }


@pytest.fixture()
def seeded():
    """The caller's data, plus a second user's, to prove the two never mix."""
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # one shared in-memory DB across TestClient threads
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)

    with factory() as db:
        user = seed_user(db, github_id=1, username="octo")
        ids = _seed_reviews(db, user, "octo/demo", ("old", "new"))

        stranger = seed_user(db, github_id=2, username="hubot")
        theirs = _seed_reviews(db, stranger, "hubot/private", ("their-old", "their-new"))

        db.commit()
        ids["headers"] = auth_headers(user)
        ids["other_headers"] = auth_headers(stranger)
        ids["their_repo"] = theirs["repo"]
        ids["their_pr"] = theirs["pr"]
        ids["their_review"] = theirs["new"]
        ids["user"] = user.id
        ids["other_user"] = stranger.id
        ids["engine"] = engine
        ids["factory"] = factory

    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    yield ids
    app.dependency_overrides.clear()


# ── Authentication ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "method,path",
    [
        ("post", "/reviews/trigger"),
        ("get", "/reviews"),
        ("get", f"/reviews/{uuid.uuid4()}"),
        ("get", f"/prs/{uuid.uuid4()}/review"),
        ("post", f"/reviews/{uuid.uuid4()}/trigger"),
    ],
)
def test_unauthenticated_request_returns_401(seeded, method: str, path: str) -> None:
    response = client.request(
        method.upper(), path, json={"owner": "octo", "repo": "demo", "pr_number": 1}
    )
    assert response.status_code == 401


# ── List ──────────────────────────────────────────────────────────────────────


def test_list_reviews_newest_first_with_join_fields(seeded) -> None:
    body = client.get("/reviews", headers=seeded["headers"]).json()
    assert [r["summary"] for r in body] == ["new", "old"]
    assert body[0]["pr_number"] == 7
    assert body[0]["repo_full_name"] == "octo/demo"


def test_list_reviews_excludes_other_users_reviews(seeded) -> None:
    body = client.get("/reviews", headers=seeded["headers"]).json()

    assert {r["summary"] for r in body} == {"new", "old"}
    assert all(r["repo_full_name"] == "octo/demo" for r in body)


def test_list_reviews_pagination(seeded) -> None:
    headers = seeded["headers"]
    assert len(client.get("/reviews?limit=1", headers=headers).json()) == 1
    assert client.get("/reviews?limit=1&offset=1", headers=headers).json()[0]["summary"] == "old"
    assert client.get("/reviews?limit=0", headers=headers).status_code == 422


def test_list_reviews_omits_raw_diff(seeded) -> None:
    # Diffs are large; the list must stay light.
    body = client.get("/reviews", headers=seeded["headers"]).json()
    assert all("raw_diff" not in item for item in body)


# ── Detail ────────────────────────────────────────────────────────────────────


def test_get_review_detail_with_comments(seeded) -> None:
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["summary"] == "new"
    assert body["verdict"] == "comment"
    assert len(body["comments"]) == 1
    assert body["comments"][0]["file_path"] == "a.py"
    assert body["comments"][0]["category"] == "logic_error"


def test_get_review_detail_names_its_pull_request(seeded) -> None:
    # A deep-linked review has nothing else to identify itself with.
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["pr_number"] == 7
    assert body["repo_full_name"] == "octo/demo"


def test_get_review_detail_exposes_raw_diff(seeded) -> None:
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["raw_diff"] == RAW_DIFF


def test_review_detail_exposes_metrics(seeded) -> None:
    """Report §8.1's numbers reach the wire, not just the database."""
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()

    assert body["duration_ms"] == 1234
    assert body["tokens_used"] == 20
    assert body["model_used"] == "m"


def test_review_detail_exposes_queued_at_and_total_ms(seeded) -> None:
    """§8.1's end-to-end figure, and the receipt it is measured from.

    `startswith` rather than an exact string: SQLite stores the timestamp
    naive, so the serialised value carries no offset suffix. The frontend
    already handles that — see `ensureUtc` in lib/utils.ts.
    """
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()

    assert body["total_ms"] == 6234
    assert body["queued_at"].startswith("2026-07-01T00:59:55")
    # Queue wait is the difference, and it is derivable rather than stored.
    assert body["total_ms"] - body["duration_ms"] == 5000


# ── my_rating (EVAL-1) ────────────────────────────────────────────────────────


def _rate(seeded, comment_id, rating: int, *, user_id=None) -> None:
    """Write a rating straight to the table.

    Direct rather than through ``POST /comments/{id}/feedback`` so these tests
    exercise the *read* path in isolation — a failure here means the detail
    handler is wrong, not that the write endpoint is.
    """
    with seeded["factory"]() as db:
        db.add(
            CommentFeedback(
                comment_id=comment_id,
                user_id=user_id or seeded["user"],
                rating=rating,
            )
        )
        db.commit()


def test_detail_my_rating_is_null_when_unrated(seeded) -> None:
    """The common case. `null` means "not rated", and must not read as a 0."""
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["comments"][0]["my_rating"] is None


def test_detail_exposes_my_rating(seeded) -> None:
    _rate(seeded, seeded["comment"], 1)
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["comments"][0]["my_rating"] == 1


def test_detail_exposes_a_negative_my_rating(seeded) -> None:
    """-1 has to survive the round trip intact; it is not a falsy "unrated"."""
    _rate(seeded, seeded["comment"], -1)
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["comments"][0]["my_rating"] == -1


def test_detail_shows_only_my_rating(seeded) -> None:
    """User B rated -1; user A sees null, not B's rating.

    The field is per-caller. Leaking it would both misreport A's own state and
    tell A what B privately thought of a comment.
    """
    _rate(seeded, seeded["comment"], -1, user_id=seeded["other_user"])
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["comments"][0]["my_rating"] is None


def test_detail_my_rating_does_not_n_plus_one(seeded) -> None:
    """Ratings cost one statement regardless of comment count.

    Ten comments queried one at a time would be ten extra round trips to render
    a page that already holds every id it needs. The assertion counts SELECTs
    against ``comment_feedback`` specifically, so unrelated queries in the
    handler cannot mask a regression.
    """
    with seeded["factory"]() as db:
        extra = [
            ReviewComment(
                review_id=seeded["new"], file_path=f"b{i}.py", line_start=1, line_end=2,
                category="improvement", severity="info", comment_text=f"Nit {i}.",
                suggestion=None,
            )
            for i in range(9)
        ]
        db.add_all(extra)
        db.commit()
        for row in extra:
            db.add(CommentFeedback(comment_id=row.id, user_id=seeded["user"], rating=1))
        db.commit()

    statements: list[str] = []

    def record(_conn, _cursor, statement, *_args) -> None:
        if "comment_feedback" in statement.lower():
            statements.append(statement)

    event.listen(seeded["engine"], "before_cursor_execute", record)
    try:
        body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    finally:
        event.remove(seeded["engine"], "before_cursor_execute", record)

    assert len(body["comments"]) == 10
    assert len(statements) == 1, statements


def test_detail_with_no_comments_issues_no_rating_query(seeded) -> None:
    """An approving review has nothing to rate; do not spend a query saying so."""
    statements: list[str] = []

    def record(_conn, _cursor, statement, *_args) -> None:
        if "comment_feedback" in statement.lower():
            statements.append(statement)

    event.listen(seeded["engine"], "before_cursor_execute", record)
    try:
        body = client.get(f"/reviews/{seeded['old']}", headers=seeded["headers"]).json()
    finally:
        event.remove(seeded["engine"], "before_cursor_execute", record)

    assert body["comments"] == []
    assert statements == []


def test_review_list_exposes_tokens_used(seeded) -> None:
    """On the list too, so a future analytics page can aggregate without an
    N+1 back to the detail endpoint."""
    body = client.get("/reviews", headers=seeded["headers"]).json()
    newest = body[0]

    assert newest["tokens_used"] == 20
    assert newest["duration_ms"] == 1234
    assert newest["model_used"] == "m"
    assert newest["total_ms"] == 6234
    assert newest["queued_at"] is not None


def test_legacy_review_without_metrics_serializes(seeded) -> None:
    """A row with every §8.1 column NULL must serialize, not 500.

    Every review already in a real database is exactly this case, so the
    fields have to be present-and-null rather than absent — a consumer
    reading `duration_ms` should get None, not a KeyError.
    """
    response = client.get(f"/reviews/{seeded['old']}", headers=seeded["headers"])

    assert response.status_code == 200
    body = response.json()
    assert body["duration_ms"] is None
    assert body["tokens_used"] is None
    assert body["model_used"] is None
    assert body["total_ms"] is None
    assert body["queued_at"] is None


def test_legacy_review_without_metrics_serializes_in_the_list(seeded) -> None:
    body = client.get("/reviews", headers=seeded["headers"]).json()
    oldest = body[1]

    assert oldest["summary"] == "old"
    assert oldest["duration_ms"] is None
    assert oldest["tokens_used"] is None
    assert oldest["total_ms"] is None
    assert oldest["queued_at"] is None


def test_get_review_404(seeded) -> None:
    assert client.get(f"/reviews/{uuid.uuid4()}", headers=seeded["headers"]).status_code == 404


def test_get_other_users_review_returns_404(seeded) -> None:
    """Indistinguishable from a review that does not exist."""
    response = client.get(f"/reviews/{seeded['their_review']}", headers=seeded["headers"])
    assert response.status_code == 404

    # ...and it is genuinely there for its owner, so 404 is about ownership.
    assert client.get(
        f"/reviews/{seeded['their_review']}", headers=seeded["other_headers"]
    ).status_code == 200


# ── PR review ─────────────────────────────────────────────────────────────────


def test_pr_review_returns_latest(seeded) -> None:
    body = client.get(f"/prs/{seeded['pr']}/review", headers=seeded["headers"]).json()
    assert body["id"] == str(seeded["new"])
    assert client.get(
        f"/prs/{uuid.uuid4()}/review", headers=seeded["headers"]
    ).status_code == 404


def test_pr_review_for_other_users_pr_returns_404(seeded) -> None:
    response = client.get(f"/prs/{seeded['their_pr']}/review", headers=seeded["headers"])
    assert response.status_code == 404


# ── Trigger ───────────────────────────────────────────────────────────────────


@pytest.fixture()
def enqueued(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, int]]:
    calls: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        reviews_api.review_worker,
        "enqueue_review",
        lambda owner, repo, pr: calls.append((owner, repo, pr)),
    )
    return calls


def test_rereview_trigger_enqueues_for_existing_review(seeded, enqueued) -> None:
    response = client.post(f"/reviews/{seeded['old']}/trigger", headers=seeded["headers"])
    assert response.status_code == 202
    assert response.json() == {"status": "queued", "repo": "octo/demo", "pr_number": 7}
    assert enqueued == [("octo", "demo", 7)]
    assert client.post(
        f"/reviews/{uuid.uuid4()}/trigger", headers=seeded["headers"]
    ).status_code == 404


def test_cannot_rereview_another_users_review(seeded, enqueued) -> None:
    response = client.post(
        f"/reviews/{seeded['their_review']}/trigger", headers=seeded["headers"]
    )
    assert response.status_code == 404
    assert enqueued == []  # and no work was queued on their behalf


def test_manual_trigger_requires_a_connected_repo(seeded, enqueued) -> None:
    """Authentication alone is not enough — this route names a repo by string.

    Without an ownership check any logged-in user could spend tokens reviewing
    an arbitrary repository.
    """
    response = client.post(
        "/reviews/trigger",
        json={"owner": "hubot", "repo": "private", "pr_number": 3},
        headers=seeded["headers"],
    )
    assert response.status_code == 404
    assert enqueued == []


def test_manual_trigger_works_for_own_repo(seeded, enqueued) -> None:
    response = client.post(
        "/reviews/trigger",
        json={"owner": "octo", "repo": "demo", "pr_number": 12},
        headers=seeded["headers"],
    )
    assert response.status_code == 202
    assert enqueued == [("octo", "demo", 12)]


# ── CORS ──────────────────────────────────────────────────────────────────────


def test_cors_headers_echoed_for_dev_origin(seeded) -> None:
    origin = "http://localhost:5173"
    response = client.get("/reviews", headers={"Origin": origin, **seeded["headers"]})
    assert response.headers["access-control-allow-origin"] == origin
