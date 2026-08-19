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


@pytest.fixture()
def filterable(seeded):
    """``seeded`` plus a second repo, a second PR number and a failed review.

    Layered on top rather than folded into ``seeded`` so the existing list
    assertions — which count on the caller owning exactly two reviews — keep
    meaning what they meant. A filter proves nothing against a fixture where
    every row already matches; this adds the rows a filter has to *exclude*.

    The caller ends up with three reviews across two repos:
    ``octo/demo`` #7 (old, new — both completed) and ``octo/other`` #203
    (one failed), newest last.
    """
    with seeded["factory"]() as db:
        repo = Repository(
            user_id=seeded["user"], github_repo_id=11, full_name="octo/other"
        )
        db.add(repo)
        db.flush()
        pr = PullRequest(
            repo_id=repo.id, github_pr_number=203, title="Ship", author="octo",
            base_branch="main", head_branch="ship", status="open",
        )
        db.add(pr)
        db.flush()
        failed = Review(
            pr_id=pr.id, status="failed", summary="other-failed",
            created_at=T0 + timedelta(hours=2),
        )
        db.add(failed)
        db.commit()

        seeded["other_repo"] = repo.id
        seeded["other_pr_number"] = 203
        seeded["failed"] = failed.id

    return seeded


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
    assert [r["summary"] for r in body["items"]] == ["new", "old"]
    assert body["items"][0]["pr_number"] == 7
    assert body["items"][0]["repo_full_name"] == "octo/demo"


def test_list_reviews_excludes_other_users_reviews(seeded) -> None:
    body = client.get("/reviews", headers=seeded["headers"]).json()

    assert {r["summary"] for r in body["items"]} == {"new", "old"}
    assert all(r["repo_full_name"] == "octo/demo" for r in body["items"])
    # The stranger's two reviews must not be counted either. A total that sees
    # rows the page cannot is the same leak, just quieter.
    assert body["total"] == 2


def test_list_reviews_pagination(seeded) -> None:
    headers = seeded["headers"]
    assert len(client.get("/reviews?limit=1", headers=headers).json()["items"]) == 1
    page_two = client.get("/reviews?limit=1&offset=1", headers=headers).json()
    assert page_two["items"][0]["summary"] == "old"
    assert client.get("/reviews?limit=0", headers=headers).status_code == 422


def test_list_reviews_total_ignores_the_page_window(seeded) -> None:
    """``total`` describes the whole set, not the slice ``limit`` asked for.

    This is the point of the envelope: without it a caller cannot tell a full
    page that is the last one from a full page with more behind it.
    """
    body = client.get("/reviews?limit=1", headers=seeded["headers"]).json()
    assert len(body["items"]) == 1
    assert body["total"] == 2


def test_list_reviews_omits_raw_diff(seeded) -> None:
    # Diffs are large; the list must stay light.
    body = client.get("/reviews", headers=seeded["headers"]).json()
    assert all("raw_diff" not in item for item in body["items"])


# ── List: filtering and sorting ───────────────────────────────────────────────


def test_list_reviews_filters_by_repo(filterable) -> None:
    headers = filterable["headers"]

    demo = client.get(
        f"/reviews?repo_id={filterable['repo']}", headers=headers
    ).json()
    assert {r["summary"] for r in demo["items"]} == {"old", "new"}
    assert demo["total"] == 2

    other = client.get(
        f"/reviews?repo_id={filterable['other_repo']}", headers=headers
    ).json()
    assert [r["summary"] for r in other["items"]] == ["other-failed"]
    assert other["total"] == 1


def test_list_reviews_filters_by_pr_number(filterable) -> None:
    body = client.get("/reviews?pr_number=203", headers=filterable["headers"]).json()

    assert [r["summary"] for r in body["items"]] == ["other-failed"]
    assert body["total"] == 1


def test_list_reviews_filters_by_status(filterable) -> None:
    headers = filterable["headers"]

    failed = client.get("/reviews?status=failed", headers=headers).json()
    assert [r["summary"] for r in failed["items"]] == ["other-failed"]
    assert failed["total"] == 1

    completed = client.get("/reviews?status=completed", headers=headers).json()
    assert {r["summary"] for r in completed["items"]} == {"old", "new"}

    # A status nothing is in must read as an empty page, not as no filter.
    pending = client.get("/reviews?status=pending", headers=headers).json()
    assert pending["items"] == []
    assert pending["total"] == 0


def test_list_reviews_sort_oldest_first(filterable) -> None:
    headers = filterable["headers"]

    assert [r["summary"] for r in client.get("/reviews?sort=oldest", headers=headers).json()["items"]] == [
        "old",
        "new",
        "other-failed",
    ]
    # The default is unchanged, so existing callers see no difference.
    assert [r["summary"] for r in client.get("/reviews", headers=headers).json()["items"]] == [
        "other-failed",
        "new",
        "old",
    ]


def test_list_reviews_filters_combine(filterable) -> None:
    """Two filters narrow; they do not fight."""
    body = client.get(
        f"/reviews?repo_id={filterable['repo']}&status=failed",
        headers=filterable["headers"],
    ).json()

    # The failed review is in the *other* repo, so the intersection is empty.
    assert body["items"] == []
    assert body["total"] == 0


def test_list_reviews_total_reflects_filters_not_page_size(filterable) -> None:
    """The trap: ``total`` is the filtered set — not the page, not the table.

    Three assertions because there are three wrong answers available. 3 would
    mean the count ignored the filter, 1 would mean it counted the page.
    """
    body = client.get(
        f"/reviews?repo_id={filterable['repo']}&limit=1", headers=filterable["headers"]
    ).json()

    assert len(body["items"]) == 1
    assert body["total"] == 2
    assert client.get("/reviews", headers=filterable["headers"]).json()["total"] == 3


def test_list_reviews_repo_filter_cannot_reach_other_users_reviews(filterable) -> None:
    """A filter narrows an owned set; it can never widen it.

    The stranger's `repo_id` is a real id that resolves to real reviews, so if
    the filter were applied *instead of* the ownership clause rather than on
    top of it this returns their data. That is a leak, not a UI bug, which is
    why it is asserted on both halves of the envelope — a `total` that counts
    rows the page withholds is the same disclosure, only quieter.
    """
    body = client.get(
        f"/reviews?repo_id={filterable['their_repo']}", headers=filterable["headers"]
    ).json()

    assert body["items"] == []
    assert body["total"] == 0


def test_list_reviews_rejects_invalid_sort(seeded) -> None:
    # 422, not a silent fallback to newest: a sort that quietly ignores what it
    # was asked for is indistinguishable from one that is broken.
    assert client.get("/reviews?sort=sideways", headers=seeded["headers"]).status_code == 422


def test_list_reviews_rejects_unknown_status(seeded) -> None:
    """`status` is closed over the four strings the worker writes.

    The frontend degrades `?status=banana` to no filter before it ever gets
    here, so this is the second line rather than the first — but a filter that
    accepted any string would silently return an empty page for a typo and
    read as "Liffy lost my reviews".
    """
    assert client.get("/reviews?status=banana", headers=seeded["headers"]).status_code == 422


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
    newest = body["items"][0]

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
    oldest = body["items"][1]

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
        # Absorbs the optional arguments without widening the recorded tuple:
        # every existing assertion here is on `(owner, repo, pr)`, and a test
        # that cares about the selection captures it itself.
        lambda owner, repo, pr, received_at=None, commit_shas=None: calls.append(
            (owner, repo, pr)
        ),
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


# ── GET /reviews/latest-finding ───────────────────────────────────────────────


def _add_comment(seeded, review_id, *, severity: str, file_path: str, text: str):
    with seeded["factory"]() as db:
        c = ReviewComment(
            review_id=review_id, file_path=file_path, line_start=10, line_end=10,
            category="security", severity=severity, comment_text=text, suggestion=None,
        )
        db.add(c)
        db.commit()
        return c.id


def _add_review(seeded, *, status: str, offset_hours: int, with_comment: bool):
    """Another review on the caller's existing PR, newer than the fixture's."""
    with seeded["factory"]() as db:
        r = Review(
            pr_id=seeded["pr"], status=status, summary="s",
            verdict="comment" if status == "completed" else None,
            created_at=T0 + timedelta(hours=offset_hours),
        )
        db.add(r)
        db.flush()
        if with_comment:
            db.add(ReviewComment(
                review_id=r.id, file_path="newer.py", line_start=3, line_end=3,
                category="convention", severity="info", comment_text="Newer.",
                suggestion=None,
            ))
        db.commit()
        return r.id


def test_latest_finding_returns_the_newest_reviews_comment(seeded) -> None:
    response = client.get("/reviews/latest-finding", headers=seeded["headers"])
    assert response.status_code == 200
    body = response.json()
    assert body["review_id"] == str(seeded["new"])
    assert body["pr_number"] == 7
    assert body["repo_full_name"] == "octo/demo"
    assert body["comment"]["file_path"] == "a.py"
    assert body["comment"]["comment_text"] == "Bug."


def test_latest_finding_never_carries_a_raw_diff(seeded) -> None:
    """The whole reason this endpoint exists rather than reusing the detail route."""
    body = client.get("/reviews/latest-finding", headers=seeded["headers"]).json()
    assert "raw_diff" not in body
    assert "raw_diff" not in body["comment"]


def test_latest_finding_excludes_other_users_findings(seeded) -> None:
    """The stranger sees their own repository, never the caller's."""
    body = client.get(
        "/reviews/latest-finding", headers=seeded["other_headers"]
    ).json()
    assert body["repo_full_name"] == "hubot/private"


def test_latest_finding_is_null_when_there_are_no_findings(seeded) -> None:
    """A fresh account is the ordinary first-run state, not a 404."""
    with seeded["factory"]() as db:
        newcomer = seed_user(db, github_id=99, username="newcomer")
        db.commit()
        headers = auth_headers(newcomer)

    response = client.get("/reviews/latest-finding", headers=headers)
    assert response.status_code == 200
    assert response.json() is None


def test_latest_finding_prefers_the_worst_severity_in_that_review(seeded) -> None:
    """Not alphabetical: that orders critical, info, warning."""
    _add_comment(seeded, seeded["new"], severity="info", file_path="z.py", text="Nit.")
    _add_comment(
        seeded, seeded["new"], severity="critical", file_path="boom.py", text="Crash."
    )

    body = client.get("/reviews/latest-finding", headers=seeded["headers"]).json()
    assert body["comment"]["severity"] == "critical"
    assert body["comment"]["file_path"] == "boom.py"


def test_latest_finding_looks_past_a_clean_review(seeded) -> None:
    """A pull request with nothing wrong is a *good* outcome, not a blank band."""
    _add_review(seeded, status="completed", offset_hours=5, with_comment=False)

    body = client.get("/reviews/latest-finding", headers=seeded["headers"]).json()
    assert body["review_id"] == str(seeded["new"])
    assert body["comment"]["comment_text"] == "Bug."


def test_latest_finding_prefers_a_newer_review_that_did_find_something(seeded) -> None:
    newer = _add_review(seeded, status="completed", offset_hours=9, with_comment=True)

    body = client.get("/reviews/latest-finding", headers=seeded["headers"]).json()
    assert body["review_id"] == str(newer)
    assert body["comment"]["file_path"] == "newer.py"


def test_latest_finding_ignores_failed_reviews(seeded) -> None:
    """A failure has nothing to show, and the dashboard is not where it belongs."""
    _add_review(seeded, status="failed", offset_hours=12, with_comment=True)

    body = client.get("/reviews/latest-finding", headers=seeded["headers"]).json()
    assert body["review_id"] == str(seeded["new"])


def test_latest_finding_is_not_parsed_as_a_review_id(seeded) -> None:
    """Route order regression: below `/reviews/{review_id}` this 422s."""
    response = client.get("/reviews/latest-finding", headers=seeded["headers"])
    assert response.status_code != 422


def test_latest_finding_requires_authentication(seeded) -> None:
    assert client.get("/reviews/latest-finding").status_code == 401


# ── include_failed ────────────────────────────────────────────────────────────


def test_list_reviews_includes_failed_by_default(filterable) -> None:
    """Omitting the param must not change any existing caller's answer."""
    body = client.get("/reviews", headers=filterable["headers"]).json()
    assert any(item["status"] == "failed" for item in body["items"])


def test_list_reviews_can_exclude_failed(filterable) -> None:
    body = client.get(
        "/reviews", params={"include_failed": "false"}, headers=filterable["headers"]
    ).json()
    assert body["items"]
    assert all(item["status"] != "failed" for item in body["items"])


def test_excluding_failed_narrows_the_total_as_well_as_the_page(filterable) -> None:
    """A total that counted rows the page omits offers a Next leading nowhere."""
    everything = client.get("/reviews", headers=filterable["headers"]).json()
    without = client.get(
        "/reviews", params={"include_failed": "false"}, headers=filterable["headers"]
    ).json()

    failed = sum(1 for item in everything["items"] if item["status"] == "failed")
    assert failed > 0, "fixture must contain a failed review for this to mean anything"
    assert without["total"] == everything["total"] - failed


def test_excluding_failed_keeps_in_flight_reviews(filterable) -> None:
    """The reason this is not `status=completed`.

    A queued or processing review is the most interesting row the dashboard can
    show, so the filter has to remove failures specifically rather than narrow
    to finished work.
    """
    with filterable["factory"]() as db:
        db.add(
            Review(
                pr_id=filterable["pr"],
                status="processing",
                created_at=T0 + timedelta(hours=3),
            )
        )
        db.commit()

    body = client.get(
        "/reviews", params={"include_failed": "false"}, headers=filterable["headers"]
    ).json()
    assert any(item["status"] == "processing" for item in body["items"])


# ── failure_detail / failure_kind ─────────────────────────────────────────────


def test_review_detail_exposes_failure_fields(seeded) -> None:
    with seeded["factory"]() as db:
        review = db.get(Review, seeded["new"])
        review.status = "failed"
        review.summary = "Review failed: Claude Code exited 1."
        review.failure_detail = '{"is_error": true, "stop_reason": "stop_sequence"}'
        review.failure_kind = "unknown"
        db.commit()

    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["failure_kind"] == "unknown"
    assert "stop_reason" in body["failure_detail"]
    # And the sentence stays a sentence.
    assert "{" not in body["summary"]


def test_failure_fields_are_null_on_a_successful_review(seeded) -> None:
    body = client.get(f"/reviews/{seeded['new']}", headers=seeded["headers"]).json()
    assert body["failure_detail"] is None
    assert body["failure_kind"] is None


# ── The commit picker endpoints ───────────────────────────────────────────────


class _CommitsGitHub:
    """Just enough GitHubClient for the picker endpoints."""

    def __init__(self, commits) -> None:
        self.commits = commits

    def list_pull_request_commits(self, owner, repo, number, **kw):
        return self.commits


def _commit(sha: str):
    from app.services.github_service import CommitMeta

    return CommitMeta(
        sha=sha, message=f"msg {sha}", author="octo", committed_at="2026-08-01T00:00:00Z"
    )


def _patch_gh(monkeypatch, commits) -> None:
    monkeypatch.setattr(
        reviews_api, "GitHubClient", lambda token=None: _CommitsGitHub(commits)
    )


def test_commits_are_flagged_new_after_the_last_reviewed_commit(
    seeded, monkeypatch
) -> None:
    with seeded["factory"]() as db:
        review = db.get(Review, seeded["new"])
        review.head_sha = "b"
        db.commit()

    _patch_gh(monkeypatch, [_commit("a"), _commit("b"), _commit("c"), _commit("d")])

    body = client.get(f"/prs/{seeded['pr']}/commits", headers=seeded["headers"]).json()

    assert [(c["sha"], c["is_new"]) for c in body] == [
        ("a", False), ("b", False), ("c", True), ("d", True),
    ]


def test_every_commit_is_new_when_nothing_has_been_reviewed(
    seeded, monkeypatch
) -> None:
    with seeded["factory"]() as db:
        for review_id in (seeded["new"], seeded["old"]):
            db.get(Review, review_id).status = "failed"
        db.commit()

    _patch_gh(monkeypatch, [_commit("a"), _commit("b")])

    body = client.get(f"/prs/{seeded['pr']}/commits", headers=seeded["headers"]).json()
    assert all(c["is_new"] for c in body)


def test_a_rewritten_boundary_marks_everything_new(seeded, monkeypatch) -> None:
    """A force-push rewrote the reviewed commit away.

    Nothing in the list is *known* to have been reviewed, and saying so beats
    marking commits old on the strength of a commit that no longer exists.
    """
    with seeded["factory"]() as db:
        db.get(Review, seeded["new"]).head_sha = "vanished"
        db.commit()

    _patch_gh(monkeypatch, [_commit("a"), _commit("b")])

    body = client.get(f"/prs/{seeded['pr']}/commits", headers=seeded["headers"]).json()
    assert all(c["is_new"] for c in body)


def test_commits_of_another_users_pull_request_are_not_readable(
    seeded, monkeypatch
) -> None:
    _patch_gh(monkeypatch, [_commit("a")])

    response = client.get(
        f"/prs/{seeded['their_pr']}/commits", headers=seeded["headers"]
    )
    assert response.status_code == 404


def test_review_commits_queues_with_the_selection(
    seeded, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict = {}
    monkeypatch.setattr(
        reviews_api.review_worker,
        "enqueue_review",
        lambda owner, repo, pr, received_at=None, commit_shas=None: captured.update(
            owner=owner, repo=repo, pr=pr, received_at=received_at, shas=commit_shas
        ),
    )

    response = client.post(
        f"/prs/{seeded['pr']}/review-commits",
        json={"shas": ["c1", "c2"]},
        headers=seeded["headers"],
    )

    assert response.status_code == 202
    assert response.json()["commits"] == 2
    assert captured["shas"] == ["c1", "c2"]
    assert captured["pr"] == 7
    # No `received_at`: this is a person asking, not a webhook delivery, which
    # is also what stops the automatic incremental rule from re-narrowing it.
    assert captured["received_at"] is None


def test_review_commits_rejects_an_empty_selection(seeded) -> None:
    """"Review nothing" is a mistake, not a request."""
    response = client.post(
        f"/prs/{seeded['pr']}/review-commits",
        json={"shas": []},
        headers=seeded["headers"],
    )
    assert response.status_code == 422


def test_review_commits_cannot_target_another_users_pull_request(seeded) -> None:
    response = client.post(
        f"/prs/{seeded['their_pr']}/review-commits",
        json={"shas": ["c1"]},
        headers=seeded["headers"],
    )
    assert response.status_code == 404


def test_picker_endpoints_require_authentication(seeded) -> None:
    assert client.get(f"/prs/{seeded['pr']}/commits").status_code == 401
    assert client.post(
        f"/prs/{seeded['pr']}/review-commits", json={"shas": ["c1"]}
    ).status_code == 401
