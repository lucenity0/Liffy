"""The two feedback routes (report §6.4) — the write half and the read half.

- ``POST /comments/{comment_id}/feedback`` (EVAL-1). The table behind it had
  never been written to, so these are the first tests asserting a rating
  survives the request at all.
- ``GET /reviews/{review_id}/eval`` (EVAL-2). It returned hardcoded zeros; the
  tests at the bottom are mostly about ``null`` not being ``0.0``.
"""

import uuid

import pytest
from conftest import auth_headers, seed_user
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app
from app.models.comment_feedback import CommentFeedback
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.review_comment import ReviewComment
from app.models.user import User

client = TestClient(app)


def _seed_review(db, user: User, full_name: str, *, comments: int = 1) -> dict:
    """A repo + PR + completed review owned by ``user``, with ``comments`` comments."""
    repo = Repository(user_id=user.id, github_repo_id=9, full_name=full_name)
    db.add(repo)
    db.flush()
    pr = PullRequest(
        repo_id=repo.id, github_pr_number=7, title="Fix", author="octo",
        base_branch="main", head_branch="fix", status="open",
    )
    db.add(pr)
    db.flush()
    review = Review(pr_id=pr.id, status="completed", summary="s", verdict="comment")
    db.add(review)
    db.flush()
    rows = [
        ReviewComment(
            review_id=review.id, file_path=f"a{i}.py", line_start=1, line_end=2,
            category="logic_error", severity="warning", comment_text=f"Bug {i}.",
            suggestion=None,
        )
        for i in range(comments)
    ]
    db.add_all(rows)
    db.flush()
    return {"review": review.id, "comments": [r.id for r in rows]}


@pytest.fixture()
def seeded():
    """The caller's review, plus a stranger's, so the ownership walk is exercised."""
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)

    with factory() as db:
        user = seed_user(db, github_id=1, username="octo")
        mine = _seed_review(db, user, "octo/demo", comments=3)

        stranger = seed_user(db, github_id=2, username="hubot")
        theirs = _seed_review(db, stranger, "hubot/private")

        db.commit()
        ids = {
            "factory": factory,
            "user": user.id,
            "other_user": stranger.id,
            "headers": auth_headers(user),
            "other_headers": auth_headers(stranger),
            "review": mine["review"],
            "comments": mine["comments"],
            "comment": mine["comments"][0],
            "their_review": theirs["review"],
            "their_comment": theirs["comments"][0],
        }

    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    yield ids
    app.dependency_overrides.clear()


def _feedback_rows(factory, comment_id=None) -> list[CommentFeedback]:
    with factory() as db:
        stmt = select(CommentFeedback)
        if comment_id is not None:
            stmt = stmt.where(CommentFeedback.comment_id == comment_id)
        return list(db.scalars(stmt))


# ── The happy path ────────────────────────────────────────────────────────────


def test_submit_feedback_persists_row(seeded) -> None:
    response = client.post(
        f"/comments/{seeded['comment']}/feedback",
        json={"rating": 1},
        headers=seeded["headers"],
    )
    assert response.status_code == 200

    body = response.json()
    assert body["comment_id"] == str(seeded["comment"])
    assert body["rating"] == 1
    assert body["created_at"] is not None

    rows = _feedback_rows(seeded["factory"], seeded["comment"])
    assert len(rows) == 1
    assert rows[0].rating == 1
    assert rows[0].user_id == seeded["user"]


# ── Validation ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("rating", [0, 7, -2, "up", None, 1.5])
def test_invalid_rating_returns_422(seeded, rating) -> None:
    """Anything but 1 or -1 is rejected by ``Literal[1, -1]`` before the handler.

    ``0`` and ``7`` are the two the issue calls out; the rest cover the shapes
    a hand-written client can produce. A ``0`` reaching the column would sit in
    the approval-rate denominator as neither approval nor disapproval.
    """
    response = client.post(
        f"/comments/{seeded['comment']}/feedback",
        json={"rating": rating},
        headers=seeded["headers"],
    )
    assert response.status_code == 422
    assert _feedback_rows(seeded["factory"]) == []


def test_missing_rating_returns_422(seeded) -> None:
    response = client.post(
        f"/comments/{seeded['comment']}/feedback", json={}, headers=seeded["headers"]
    )
    assert response.status_code == 422
    assert _feedback_rows(seeded["factory"]) == []


# ── Authentication and ownership ──────────────────────────────────────────────


def test_unauthenticated_returns_401(seeded) -> None:
    response = client.post(f"/comments/{seeded['comment']}/feedback", json={"rating": 1})
    assert response.status_code == 401
    assert _feedback_rows(seeded["factory"]) == []


def test_unknown_comment_returns_404(seeded) -> None:
    response = client.post(
        f"/comments/{uuid.uuid4()}/feedback", json={"rating": 1}, headers=seeded["headers"]
    )
    assert response.status_code == 404


def test_other_users_comment_returns_404(seeded) -> None:
    """A comment on somebody else's review is indistinguishable from one that
    does not exist — and nothing is written.

    A 403 would confirm the row is real, which is the information worth hiding.
    The write assertion is the half that matters: a 404 that still persisted a
    row would let one user seed another's approval rate.
    """
    response = client.post(
        f"/comments/{seeded['their_comment']}/feedback",
        json={"rating": 1},
        headers=seeded["headers"],
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Comment not found"
    assert _feedback_rows(seeded["factory"]) == []


# ── Re-rating ─────────────────────────────────────────────────────────────────


def test_rerating_replaces_not_duplicates(seeded) -> None:
    """Thumbs up then thumbs down leaves one row at -1.

    Without this, one indecisive click makes the approval rate wrong forever
    and nothing anywhere says so.
    """
    client.post(
        f"/comments/{seeded['comment']}/feedback",
        json={"rating": 1},
        headers=seeded["headers"],
    )
    response = client.post(
        f"/comments/{seeded['comment']}/feedback",
        json={"rating": -1},
        headers=seeded["headers"],
    )
    assert response.status_code == 200
    assert response.json()["rating"] == -1

    rows = _feedback_rows(seeded["factory"], seeded["comment"])
    assert len(rows) == 1
    assert rows[0].rating == -1


def test_rerating_keeps_the_original_created_at(seeded) -> None:
    """``created_at`` is when the rating was first given, and does not move.

    There is no ``updated_at`` on this table by design (report §5), so the
    column has to mean one thing consistently.
    """
    first = client.post(
        f"/comments/{seeded['comment']}/feedback",
        json={"rating": 1},
        headers=seeded["headers"],
    ).json()
    second = client.post(
        f"/comments/{seeded['comment']}/feedback",
        json={"rating": -1},
        headers=seeded["headers"],
    ).json()
    assert second["created_at"] == first["created_at"]


def test_two_users_rate_the_same_comment(seeded) -> None:
    """The constraint is per (comment, user), not per comment.

    Both ratings are kept — two people disagreeing about one comment is a
    normal outcome, and collapsing it would discard half the signal. It is also
    what makes ``my_rating`` a per-caller field rather than "the" rating.

    The second user's row is inserted directly rather than through the API:
    ``repositories`` has a single ``user_id``, so no second user can currently
    reach this comment over HTTP. That is a property of who can *reach* a
    comment, not of what the table permits — and it is the table's behaviour
    under two raters that the approval rate depends on.
    """
    factory = seeded["factory"]
    with factory() as db:
        db.add(
            CommentFeedback(
                comment_id=seeded["comment"], user_id=seeded["other_user"], rating=-1
            )
        )
        db.commit()

    client.post(
        f"/comments/{seeded['comment']}/feedback",
        json={"rating": 1},
        headers=seeded["headers"],
    )

    rows = _feedback_rows(factory, seeded["comment"])
    assert len(rows) == 2
    assert {r.rating for r in rows} == {1, -1}


def test_rating_a_second_comment_adds_a_row(seeded) -> None:
    """The uniqueness is per comment too — rating two comments is two rows."""
    for comment_id in seeded["comments"][:2]:
        client.post(
            f"/comments/{comment_id}/feedback",
            json={"rating": 1},
            headers=seeded["headers"],
        )
    assert len(_feedback_rows(seeded["factory"])) == 2


def test_the_database_rejects_a_duplicate_pair(seeded) -> None:
    """The constraint holds independently of the handler.

    ``submit_feedback`` selects-then-updates, so the handler alone would keep
    the table clean and this constraint would never fire. That is exactly why
    it is worth a test: it is the backstop for every *other* writer — a fixture,
    a migration, a future bulk import — and a backstop nothing exercises is one
    nobody notices was dropped.
    """
    with seeded["factory"]() as db:
        db.add(
            CommentFeedback(comment_id=seeded["comment"], user_id=seeded["user"], rating=1)
        )
        db.commit()

    with seeded["factory"]() as db:
        db.add(
            CommentFeedback(comment_id=seeded["comment"], user_id=seeded["user"], rating=-1)
        )
        with pytest.raises(IntegrityError):
            db.commit()


# ── GET /reviews/{review_id}/eval (EVAL-2) ────────────────────────────────────


def test_eval_endpoint_returns_computed_scores(seeded) -> None:
    """Real numbers off real rows, not the stub's hardcoded zeros."""
    for comment_id in seeded["comments"][:2]:
        client.post(
            f"/comments/{comment_id}/feedback",
            json={"rating": 1},
            headers=seeded["headers"],
        )
    client.post(
        f"/comments/{seeded['comments'][2]}/feedback",
        json={"rating": -1},
        headers=seeded["headers"],
    )

    body = client.get(f"/reviews/{seeded['review']}/eval", headers=seeded["headers"]).json()

    assert body["review_id"] == str(seeded["review"])
    assert body["total_comments"] == 3
    assert body["rated_comments"] == 3
    assert body["approval_rate"] == pytest.approx(2 / 3)
    assert body["false_positive_rate"] == pytest.approx(1 / 3)


def test_eval_endpoint_null_rates_serialize(seeded) -> None:
    """An unrated review is JSON ``null`` — not ``0.0``, and not a 500.

    The stub returned `{"approval_rate": 0.0}` here, which reads as "this
    review was rejected" for a review nobody has looked at. Preserving the
    distinction through Pydantic and into the response body is the whole point
    of the issue, so it is asserted on the wire rather than on the dataclass.
    """
    response = client.get(f"/reviews/{seeded['review']}/eval", headers=seeded["headers"])

    assert response.status_code == 200
    body = response.json()
    assert body["approval_rate"] is None
    assert body["false_positive_rate"] is None
    assert body["total_comments"] == 3
    assert body["rated_comments"] == 0
    # Belt and braces: `null` in the raw text, so a serializer that coerced it
    # to 0 could not pass by round-tripping through Python truthiness.
    assert '"approval_rate":null' in response.text.replace(" ", "")


def test_eval_endpoint_reflects_a_rating_immediately(seeded) -> None:
    """Live from ``comment_feedback``, not from the weekly ``eval_scores`` snapshot.

    #192's beat job runs on Mondays; this endpoint has to answer for a
    thumbs-up from ten seconds ago.
    """
    before = client.get(f"/reviews/{seeded['review']}/eval", headers=seeded["headers"]).json()
    assert before["approval_rate"] is None

    client.post(
        f"/comments/{seeded['comment']}/feedback",
        json={"rating": 1},
        headers=seeded["headers"],
    )

    after = client.get(f"/reviews/{seeded['review']}/eval", headers=seeded["headers"]).json()
    assert after["approval_rate"] == 1.0


def test_eval_endpoint_unauthenticated_401(seeded) -> None:
    assert client.get(f"/reviews/{seeded['review']}/eval").status_code == 401


def test_eval_endpoint_unknown_review_404(seeded) -> None:
    response = client.get(f"/reviews/{uuid.uuid4()}/eval", headers=seeded["headers"])
    assert response.status_code == 404


def test_eval_endpoint_other_users_review_404(seeded) -> None:
    """Somebody else's scores are as invisible as their review."""
    response = client.get(
        f"/reviews/{seeded['their_review']}/eval", headers=seeded["headers"]
    )
    assert response.status_code == 404


def test_eval_endpoint_ignores_another_users_ratings(seeded) -> None:
    """The rate pools every rating on the caller's own review.

    A stranger cannot reach these comments over HTTP, but their rows must not
    be excluded by an accidental `user_id == caller` filter either — the
    approval rate is about the review, not about who is looking at it.
    """
    with seeded["factory"]() as db:
        db.add(
            CommentFeedback(
                comment_id=seeded["comment"], user_id=seeded["other_user"], rating=-1
            )
        )
        db.commit()

    body = client.get(f"/reviews/{seeded['review']}/eval", headers=seeded["headers"]).json()
    assert body["rated_comments"] == 1
    assert body["approval_rate"] == 0.0
