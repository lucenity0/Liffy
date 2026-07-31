"""``eval_service`` — report §8.1's five metrics.

- ``compute_review_scores`` (EVAL-2): approval and false-positive rate for one
  review. Mostly about ``None`` not being ``0.0``.
- ``category_distribution``, ``severity_calibration``, ``token_efficiency``
  (EVAL-4): fleet-wide, and computable with no feedback at all.

No HTTP anywhere in this file — the service takes a ``Session`` and returns
plain values, which is what makes the arithmetic testable without a server.
"""

import uuid
from datetime import datetime, timezone

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
from app.schemas.review import ReviewCategory
from app.services.eval_service import (
    category_distribution,
    compute_review_scores,
    severity_calibration,
    token_efficiency,
    token_efficiency_points,
)


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


# ── Category distribution (EVAL-4, §8.1 row 4) ────────────────────────────────


def _comment(db, review: Review, *, category: str, severity: str = "warning") -> ReviewComment:
    row = ReviewComment(
        review_id=review.id, file_path="x.py", line_start=1, line_end=1,
        category=category, severity=severity, comment_text="c",
    )
    db.add(row)
    db.flush()
    return row


def test_distribution_includes_zero_categories(db, owner) -> None:
    """The headline test.

    Comments in two categories only; all six keys come back, the other four at
    zero. A `GROUP BY` alone returns just the two — and "0 security comments"
    is the finding, not the absence of one.
    """
    review = _review(db, comments=0, user=owner)
    _comment(db, review, category="logic_error")
    _comment(db, review, category="logic_error")
    _comment(db, review, category="improvement")

    dist = category_distribution(db, user_id=owner.id)

    assert set(dist) == {c.value for c in ReviewCategory}
    assert dist == {
        "logic_error": 2,
        "improvement": 1,
        "security": 0,
        "performance": 0,
        "architecture": 0,
        "convention": 0,
    }


def test_distribution_empty_when_no_comments(db, owner) -> None:
    """Six zeros, not `{}` — a fresh account still has a shape to render."""
    dist = category_distribution(db, user_id=owner.id)
    assert dist == {c.value: 0 for c in ReviewCategory}


def test_distribution_scoped_to_callers_repos(db, owner) -> None:
    """Another user's comments do not leak in."""
    stranger = seed_user(db, github_id=2, username="hubot")
    mine = _review(db, comments=0, user=owner)
    theirs = _review(db, comments=0, user=stranger)
    _comment(db, mine, category="security")
    for _ in range(5):
        _comment(db, theirs, category="security")

    assert category_distribution(db, user_id=owner.id)["security"] == 1
    assert category_distribution(db, user_id=stranger.id)["security"] == 5


def test_distribution_can_be_scoped_to_one_repo(db, owner) -> None:
    first = _review(db, comments=0, user=owner)
    second = _review(db, comments=0, user=owner)
    _comment(db, first, category="convention")
    _comment(db, second, category="performance")

    repo_id = db.get(PullRequest, first.pr_id).repo_id
    dist = category_distribution(db, user_id=owner.id, repo_id=repo_id)

    assert dist["convention"] == 1
    assert dist["performance"] == 0


def test_unknown_category_buckets_as_other(db, owner) -> None:
    """`category` is a plain String column; one odd row must not break the metric.

    `other` appears only because it is non-zero — the common case stays at
    exactly six keys, which is what #201's six-bar chart iterates.
    """
    review = _review(db, comments=0, user=owner)
    _comment(db, review, category="logic_error")
    _comment(db, review, category="wat")

    dist = category_distribution(db, user_id=owner.id)

    assert dist["other"] == 1
    assert dist["logic_error"] == 1
    assert set(dist) == {c.value for c in ReviewCategory} | {"other"}


def test_other_is_absent_when_every_category_is_known(db, owner) -> None:
    review = _review(db, comments=0, user=owner)
    _comment(db, review, category="security")

    assert "other" not in category_distribution(db, user_id=owner.id)


# ── Severity calibration (EVAL-4, §8.1 row 3) ─────────────────────────────────


def test_calibration_returns_all_three_severities(db, owner) -> None:
    rows = severity_calibration(db, user_id=owner.id)
    assert [r.severity for r in rows] == ["critical", "warning", "info"]


def test_calibration_reports_sample_size(db, owner) -> None:
    """A rate without its n is the one thing that must not reach the page."""
    review = _review(db, comments=0, user=owner)
    _comment(db, review, category="logic_error", severity="critical")

    critical = next(r for r in severity_calibration(db, user_id=owner.id) if r.severity == "critical")
    assert critical.comments == 1
    assert critical.prs_with_comment == 1
    assert critical.prs_still_open == 1
    assert critical.still_open_rate == 1.0


def test_calibration_with_no_critical_comments_does_not_divide_by_zero(db, owner) -> None:
    """A severity Liffy never emitted has no rate — `None`, not `0.0`.

    `0.0` would read as "every such PR was resolved", which is a claim about
    PRs that do not exist.
    """
    review = _review(db, comments=0, user=owner)
    _comment(db, review, category="improvement", severity="info")

    critical = next(r for r in severity_calibration(db, user_id=owner.id) if r.severity == "critical")
    assert critical.comments == 0
    assert critical.prs_with_comment == 0
    assert critical.still_open_rate is None


def test_calibration_counts_a_pr_once_even_with_several_critical_comments(db, owner) -> None:
    """Per PR, not per comment — one noisy review must not dominate the audit."""
    review = _review(db, comments=0, user=owner)
    for _ in range(4):
        _comment(db, review, category="logic_error", severity="critical")

    critical = next(r for r in severity_calibration(db, user_id=owner.id) if r.severity == "critical")
    assert critical.comments == 4
    assert critical.prs_with_comment == 1


def test_calibration_counts_closed_prs_out_of_the_open_tally(db, owner) -> None:
    open_review = _review(db, comments=0, user=owner)
    closed_review = _review(db, comments=0, user=owner)
    db.get(PullRequest, closed_review.pr_id).status = "closed"
    db.flush()
    _comment(db, open_review, category="logic_error", severity="critical")
    _comment(db, closed_review, category="logic_error", severity="critical")

    critical = next(r for r in severity_calibration(db, user_id=owner.id) if r.severity == "critical")
    assert critical.prs_with_comment == 2
    assert critical.prs_still_open == 1
    assert critical.still_open_rate == 0.5


def test_calibration_scoped_to_callers_repos(db, owner) -> None:
    stranger = seed_user(db, github_id=2, username="hubot")
    _comment(db, _review(db, comments=0, user=stranger), category="logic_error", severity="critical")

    critical = next(r for r in severity_calibration(db, user_id=owner.id) if r.severity == "critical")
    assert critical.comments == 0


# ── Token efficiency (EVAL-4, §8.1 row 5) ─────────────────────────────────────


def test_token_efficiency_none_when_no_data(db, owner) -> None:
    assert token_efficiency(db, user_id=owner.id) is None
    assert token_efficiency_points(db, user_id=owner.id) == []


def test_token_efficiency_excludes_null_tokens_used(db, owner) -> None:
    """A legacy row with `tokens_used = NULL` is excluded, not treated as 0.

    Counting it as free would make efficiency look better the further back you
    look — and every row written before METRIC-1 is exactly this shape.
    """
    legacy = _review(db, comments=1, user=owner)  # tokens_used stays NULL
    _rate(db, _comments(db, legacy)[0], 1, owner)

    assert token_efficiency_points(db, user_id=owner.id) == []
    assert token_efficiency(db, user_id=owner.id) is None


def test_token_efficiency_excludes_zero_tokens(db, owner) -> None:
    """Zero tokens is a division by zero, and no real review costs nothing."""
    review = _review(db, comments=1, user=owner)
    review.tokens_used = 0
    db.flush()
    _rate(db, _comments(db, review)[0], 1, owner)

    assert token_efficiency(db, user_id=owner.id) is None


def test_token_efficiency_excludes_unrated_reviews(db, owner) -> None:
    """Tokens without feedback is not efficiency — there is no numerator."""
    review = _review(db, comments=1, user=owner)
    review.tokens_used = 25_000
    db.flush()

    assert token_efficiency(db, user_id=owner.id) is None


def test_token_efficiency_computes_approval_per_thousand_tokens(db, owner) -> None:
    """100% approval over 25,000 tokens -> 1.0 / 25 = 0.04."""
    review = _review(db, comments=2, user=owner)
    review.tokens_used = 25_000
    db.flush()
    for comment in _comments(db, review):
        _rate(db, comment, 1, owner)

    assert token_efficiency(db, user_id=owner.id) == pytest.approx(0.04)


def test_token_efficiency_points_are_oldest_first(db, owner) -> None:
    """#201 draws a trend, which needs the series in time order."""
    first = _review(db, comments=1, user=owner)
    first.tokens_used, first.created_at = 10_000, datetime(2026, 7, 1, tzinfo=timezone.utc)
    second = _review(db, comments=1, user=owner)
    second.tokens_used, second.created_at = 10_000, datetime(2026, 7, 2, tzinfo=timezone.utc)
    db.flush()
    _rate(db, _comments(db, first)[0], 1, owner)
    _rate(db, _comments(db, second)[0], -1, owner)

    points = token_efficiency_points(db, user_id=owner.id)
    assert [p.review_id for p in points] == [first.id, second.id]
    assert points[0].value == pytest.approx(0.1)   # 1.0 / 10
    assert points[1].value == 0.0                  # 0.0 / 10


def test_token_efficiency_is_the_mean_of_the_points(db, owner) -> None:
    """The scalar and the series must not disagree — they come from one query."""
    for approval, tokens in ((1, 10_000), (-1, 10_000)):
        review = _review(db, comments=1, user=owner)
        review.tokens_used = tokens
        db.flush()
        _rate(db, _comments(db, review)[0], approval, owner)

    points = token_efficiency_points(db, user_id=owner.id)
    assert token_efficiency(db, user_id=owner.id) == pytest.approx(
        sum(p.value for p in points) / len(points)
    )


def test_token_efficiency_scoped_to_callers_repos(db, owner) -> None:
    stranger = seed_user(db, github_id=2, username="hubot")
    theirs = _review(db, comments=1, user=stranger)
    theirs.tokens_used = 1_000
    db.flush()
    _rate(db, _comments(db, theirs)[0], 1, stranger)

    assert token_efficiency(db, user_id=owner.id) is None
    assert token_efficiency(db, user_id=stranger.id) == pytest.approx(1.0)
