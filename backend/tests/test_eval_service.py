"""eval_service.compute_review_scores (EVAL-2, report §8.1).

No HTTP anywhere in this file — the service takes a ``Session`` and returns
plain values, which is what makes the arithmetic testable without a server.
"""

import uuid

import pytest
from conftest import seed_user
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base
from app.models.comment_feedback import CommentFeedback
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.review_comment import ReviewComment
from app.models.user import User
from app.services.eval_service import compute_review_scores


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite://", future=True, connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine, autoflush=False)() as session:
        yield session


@pytest.fixture()
def owner(db) -> User:
    """Whoever connected the repository — and, today, its only possible rater."""
    return seed_user(db, github_id=1, username="octo")


_seq = iter(range(1000, 9000))


def _review(db, *, comments: int, user: User, status: str = "completed") -> Review:
    """A review owned by ``user``, carrying ``comments`` comments.

    Each call gets its own repo and PR, so two reviews in one test cannot
    collide on ``github_repo_id`` or PR number.
    """
    n = next(_seq)
    repo = Repository(user_id=user.id, github_repo_id=n, full_name=f"octo/demo{n}")
    db.add(repo)
    db.flush()
    pr = PullRequest(
        repo_id=repo.id, github_pr_number=n, title="t", author="octo",
        base_branch="main", head_branch="fix", status="open",
    )
    db.add(pr)
    db.flush()
    review = Review(pr_id=pr.id, status=status, summary="s", verdict="comment")
    db.add(review)
    db.flush()
    db.add_all(
        ReviewComment(
            review_id=review.id, file_path=f"a{i}.py", line_start=1, line_end=2,
            category="logic_error", severity="warning", comment_text=f"c{i}",
        )
        for i in range(comments)
    )
    db.flush()
    return review


def _comments(db, review: Review) -> list[ReviewComment]:
    return list(
        db.scalars(
            select(ReviewComment)
            .where(ReviewComment.review_id == review.id)
            .order_by(ReviewComment.file_path)
        )
    )


def _rate(db, comment: ReviewComment, rating: int, user: User) -> None:
    db.add(CommentFeedback(comment_id=comment.id, user_id=user.id, rating=rating))
    db.flush()


# ── The rates ─────────────────────────────────────────────────────────────────


def test_all_thumbs_up_is_100_percent(db, owner) -> None:
    review = _review(db, comments=3, user=owner)
    for comment in _comments(db, review):
        _rate(db, comment, 1, owner)

    scores = compute_review_scores(db, review.id)
    assert scores.approval_rate == 1.0
    assert scores.false_positive_rate == 0.0
    assert scores.rated_comments == 3


def test_all_thumbs_down_is_zero_percent(db, owner) -> None:
    """``0.0``, and distinctly not ``None``.

    Every rating negative is a real, terrible score. Collapsing it into the
    same value as "nobody rated" is exactly the bug this issue removes.
    """
    review = _review(db, comments=2, user=owner)
    for comment in _comments(db, review):
        _rate(db, comment, -1, owner)

    scores = compute_review_scores(db, review.id)
    assert scores.approval_rate == 0.0
    assert scores.approval_rate is not None
    assert scores.false_positive_rate == 1.0


def test_mixed_ratings(db, owner) -> None:
    review = _review(db, comments=4, user=owner)
    comments = _comments(db, review)
    for comment in comments[:3]:
        _rate(db, comment, 1, owner)
    _rate(db, comments[3], -1, owner)

    scores = compute_review_scores(db, review.id)
    assert scores.approval_rate == 0.75
    assert scores.false_positive_rate == 0.25


def test_unrated_review_returns_none_not_zero(db, owner) -> None:
    """The headline test.

    A review nobody has rated has no approval rate. Reporting ``0.0`` says its
    comments were rejected, which is a claim about data that does not exist.
    """
    review = _review(db, comments=3, user=owner)

    scores = compute_review_scores(db, review.id)
    assert scores.approval_rate is None
    assert scores.false_positive_rate is None
    assert scores.total_comments == 3
    assert scores.rated_comments == 0


def test_partially_rated_uses_rated_denominator(db, owner) -> None:
    """8 comments, 2 rated, both up -> 1.0, not 0.25.

    The denominator is what was rated. Otherwise the metric punishes a review
    for going unread, which is a fact about the reader.
    """
    review = _review(db, comments=8, user=owner)
    for comment in _comments(db, review)[:2]:
        _rate(db, comment, 1, owner)

    scores = compute_review_scores(db, review.id)
    assert scores.approval_rate == 1.0
    assert scores.total_comments == 8
    assert scores.rated_comments == 2


def test_false_positive_rate_is_the_complement(db, owner) -> None:
    """ADR 004's decision, pinned.

    If this ever stops holding, either the schema grew a ``reason`` column or
    somebody changed the semantics without superseding the ADR.
    """
    review = _review(db, comments=5, user=owner)
    comments = _comments(db, review)
    for comment in comments[:3]:
        _rate(db, comment, 1, owner)
    for comment in comments[3:]:
        _rate(db, comment, -1, owner)

    scores = compute_review_scores(db, review.id)
    assert scores.approval_rate == pytest.approx(0.6)
    assert scores.false_positive_rate == pytest.approx(1.0 - scores.approval_rate)


# ── Edges ─────────────────────────────────────────────────────────────────────


def test_review_with_no_comments_does_not_crash(db, owner) -> None:
    """An approving review has nothing to rate, and that is not a failure."""
    review = _review(db, comments=0, user=owner)

    scores = compute_review_scores(db, review.id)
    assert scores.total_comments == 0
    assert scores.rated_comments == 0
    assert scores.approval_rate is None
    assert scores.false_positive_rate is None


def test_unknown_review_returns_none(db) -> None:
    assert compute_review_scores(db, uuid.uuid4()) is None


def test_unknown_review_is_distinct_from_an_unrated_one(db, owner) -> None:
    """``None`` the object versus ``None`` the rate — two different answers.

    Both read as "no data" at a glance, and the API turns one into a 404 and
    the other into a 200 with nulls.
    """
    review = _review(db, comments=1, user=owner)

    assert compute_review_scores(db, uuid.uuid4()) is None
    assert compute_review_scores(db, review.id) is not None


def test_ratings_from_multiple_users_all_count(db, owner) -> None:
    """Two raters on one comment produce two ratings, both in the denominator.

    Not reachable over HTTP today — a repository has one owner — but the table
    permits it, and dropping one silently would be the wrong arithmetic the
    moment it becomes reachable.
    """
    other = seed_user(db, github_id=2, username="hubot")
    review = _review(db, comments=1, user=owner)
    comment = _comments(db, review)[0]

    _rate(db, comment, 1, owner)
    _rate(db, comment, -1, other)

    scores = compute_review_scores(db, review.id)
    assert scores.rated_comments == 2
    assert scores.approval_rate == 0.5
    # The comment is still one comment: the fan-out from the outer join must
    # not inflate the total. This is what `count(distinct ...)` is for.
    assert scores.total_comments == 1


def test_ratings_on_another_review_do_not_leak_in(db, owner) -> None:
    """Scoped to the review under test, not to the whole table."""
    reviewed = _review(db, comments=1, user=owner)
    other = _review(db, comments=1, user=owner)

    _rate(db, _comments(db, reviewed)[0], 1, owner)
    _rate(db, _comments(db, other)[0], -1, owner)

    assert compute_review_scores(db, reviewed.id).approval_rate == 1.0
    assert compute_review_scores(db, other.id).approval_rate == 0.0


def test_a_review_with_comments_but_no_feedback_reports_its_comment_count(db, owner) -> None:
    """``total_comments`` is independent of whether anything was rated.

    #199 renders "0 of 8 rated", which needs the 8 even when the rate is null.
    """
    review = _review(db, comments=8, user=owner)

    scores = compute_review_scores(db, review.id)
    assert scores.total_comments == 8
    assert scores.approval_rate is None
