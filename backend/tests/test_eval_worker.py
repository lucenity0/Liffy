"""The weekly eval_scores job (EVAL-3, report §8.2 bullets 2 and 3).

The task function is called **directly**, never through a running Celery
worker — the same pattern ``test_workers.py`` uses. A test that needs a broker
is a test that fails for reasons unrelated to the code under it.
"""

import logging

import pytest
from conftest import seed_user
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base
from app.models.comment_feedback import CommentFeedback
from app.models.eval_score import EvalScore
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.review_comment import ReviewComment
from app.models.user import User
from app.workers import eval_worker

_seq = iter(range(1000, 9000))


@pytest.fixture()
def factory(monkeypatch):
    """An in-memory database wired in as the worker's ``SessionLocal``.

    The task owns its own session — it runs with no request context — so the
    seam for a test is the session factory, not a dependency override.
    """
    engine = create_engine(
        "sqlite://", future=True, connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setattr(eval_worker, "SessionLocal", sessions)
    return sessions


@pytest.fixture()
def db(factory):
    with factory() as session:
        yield session


@pytest.fixture()
def owner(db) -> User:
    return seed_user(db, github_id=1, username="octo")


def _review(db, owner: User, *, status: str = "completed", comments: int = 0) -> Review:
    n = next(_seq)
    repo = Repository(user_id=owner.id, github_repo_id=n, full_name=f"octo/r{n}")
    db.add(repo)
    db.flush()
    pr = PullRequest(
        repo_id=repo.id, github_pr_number=n, title="t", author="octo",
        base_branch="main", head_branch="f", status="open",
    )
    db.add(pr)
    db.flush()
    review = Review(pr_id=pr.id, status=status, summary="s", verdict="comment")
    db.add(review)
    db.flush()
    db.add_all(
        ReviewComment(
            review_id=review.id, file_path=f"a{i}.py", line_start=1, line_end=1,
            category="logic_error", severity="warning", comment_text="c",
        )
        for i in range(comments)
    )
    db.flush()
    return review


def _rate_all(db, review: Review, owner: User, ratings: list[int]) -> None:
    """Apply ``ratings`` to the review's comments, in order."""
    comments = list(
        db.scalars(
            select(ReviewComment)
            .where(ReviewComment.review_id == review.id)
            .order_by(ReviewComment.file_path)
        )
    )
    for comment, rating in zip(comments, ratings):
        db.add(CommentFeedback(comment_id=comment.id, user_id=owner.id, rating=rating))
    db.commit()


def _scores(factory) -> list[EvalScore]:
    with factory() as session:
        return list(session.scalars(select(EvalScore)))


# ── What gets scored ──────────────────────────────────────────────────────────


def test_scores_all_completed_reviews(factory, db, owner) -> None:
    first = _review(db, owner, comments=2)
    second = _review(db, owner, comments=2)
    _rate_all(db, first, owner, [1, 1])
    _rate_all(db, second, owner, [1, -1])

    result = eval_worker.compute_eval_scores_task()

    assert result["scored"] == 2
    rows = {row.review_id: row for row in _scores(factory)}
    assert rows[first.id].approval_rate == 1.0
    assert rows[second.id].approval_rate == 0.5


def test_skips_reviews_without_feedback(factory, db, owner) -> None:
    """No row written, and counted as skipped.

    ``eval_scores.approval_rate`` is ``Float NOT NULL``, so a row for an
    unrated review would mean either crashing or storing a fabricated ``0.0``.
    Skipping is the only honest option: no feedback is not a score.
    """
    _review(db, owner, comments=3)
    db.commit()

    result = eval_worker.compute_eval_scores_task()

    assert result == {"scored": 0, "skipped": 1, "failed": 0}
    assert _scores(factory) == []


def test_skips_a_completed_review_with_no_comments(factory, db, owner) -> None:
    """An approving review has nothing to rate, so it has no score either."""
    _review(db, owner, comments=0)
    db.commit()

    assert eval_worker.compute_eval_scores_task()["skipped"] == 1
    assert _scores(factory) == []


@pytest.mark.parametrize("status", ["pending", "processing", "failed"])
def test_skips_pending_and_failed_reviews(factory, db, owner, status: str) -> None:
    """Only ``completed`` is scored — an in-flight review has nothing final."""
    review = _review(db, owner, status=status, comments=1)
    _rate_all(db, review, owner, [1])

    result = eval_worker.compute_eval_scores_task()

    assert result["scored"] == 0
    assert _scores(factory) == []


# ── Idempotency ───────────────────────────────────────────────────────────────


def test_rerunning_updates_rather_than_duplicates(factory, db, owner) -> None:
    """The test that proves the upsert.

    A naive insert grows a new row every Monday, and "the latest score" becomes
    ``ORDER BY computed_at DESC LIMIT 1`` in every caller, forever.
    """
    review = _review(db, owner, comments=2)
    _rate_all(db, review, owner, [1, 1])

    eval_worker.compute_eval_scores_task()
    eval_worker.compute_eval_scores_task()

    rows = _scores(factory)
    assert len(rows) == 1
    assert rows[0].approval_rate == 1.0


def test_rerunning_picks_up_a_changed_rating(factory, db, owner) -> None:
    """The row is updated in place, not left stale at the first value."""
    review = _review(db, owner, comments=2)
    _rate_all(db, review, owner, [1, 1])
    eval_worker.compute_eval_scores_task()

    with factory() as session:
        feedback = session.scalars(select(CommentFeedback)).first()
        feedback.rating = -1
        session.commit()

    eval_worker.compute_eval_scores_task()

    rows = _scores(factory)
    assert len(rows) == 1
    assert rows[0].approval_rate == 0.5


# ── Flagging (report §8.2 bullet 3) ───────────────────────────────────────────


def test_flags_review_below_fifty_percent(factory, db, owner) -> None:
    review = _review(db, owner, comments=4)
    _rate_all(db, review, owner, [1, -1, -1, -1])  # 0.25

    eval_worker.compute_eval_scores_task()

    rows = _scores(factory)
    assert rows[0].approval_rate == 0.25
    assert rows[0].flagged is True


def test_does_not_flag_review_exactly_at_fifty_percent(factory, db, owner) -> None:
    """The boundary, asserted explicitly.

    ``<`` versus ``<=`` is a coin flip otherwise, and §8.2 says *below* 50%.
    """
    review = _review(db, owner, comments=2)
    _rate_all(db, review, owner, [1, -1])  # exactly 0.5

    eval_worker.compute_eval_scores_task()

    rows = _scores(factory)
    assert rows[0].approval_rate == 0.5
    assert rows[0].flagged is False


def test_does_not_flag_review_above_fifty_percent(factory, db, owner) -> None:
    review = _review(db, owner, comments=4)
    _rate_all(db, review, owner, [1, 1, 1, -1])  # 0.75

    eval_worker.compute_eval_scores_task()
    assert _scores(factory)[0].flagged is False


def test_flagging_logs_a_warning(factory, db, owner, caplog) -> None:
    """The log is the notification — there is no alerting on this project."""
    review = _review(db, owner, comments=2)
    _rate_all(db, review, owner, [-1, -1])

    with caplog.at_level(logging.WARNING, logger="app.workers.eval_worker"):
        eval_worker.compute_eval_scores_task()

    assert str(review.id) in caplog.text
    assert "flagged" in caplog.text


def test_a_review_that_recovers_is_unflagged(factory, db, owner) -> None:
    """The flag is recomputed, not sticky — otherwise it can only ever grow."""
    review = _review(db, owner, comments=2)
    _rate_all(db, review, owner, [-1, -1])
    eval_worker.compute_eval_scores_task()
    assert _scores(factory)[0].flagged is True

    with factory() as session:
        for feedback in session.scalars(select(CommentFeedback)):
            feedback.rating = 1
        session.commit()

    eval_worker.compute_eval_scores_task()
    assert _scores(factory)[0].flagged is False


# ── Reporting and resilience ──────────────────────────────────────────────────


def test_returns_scored_and_skipped_counts(factory, db, owner) -> None:
    """A run that scored nothing and a run that found nothing look identical
    without these counts, and Celery's result backend is the only place they
    reach a caller."""
    rated = _review(db, owner, comments=1)
    _rate_all(db, rated, owner, [1])
    _review(db, owner, comments=1)
    db.commit()

    assert eval_worker.compute_eval_scores_task() == {
        "scored": 1, "skipped": 1, "failed": 0,
    }


def test_one_bad_review_does_not_abort_the_run(factory, db, owner, monkeypatch) -> None:
    """The whole point of the per-review guard.

    A review deleted between the id query and the write is a real race on a
    long run; without this, one row loses every score after it.
    """
    first = _review(db, owner, comments=1)
    second = _review(db, owner, comments=1)
    _rate_all(db, first, owner, [1])
    _rate_all(db, second, owner, [1])

    real = eval_worker.compute_review_scores
    calls = {"n": 0}

    def exploding(db_session, review_id):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        return real(db_session, review_id)

    monkeypatch.setattr(eval_worker, "compute_review_scores", exploding)

    result = eval_worker.compute_eval_scores_task()

    assert result["failed"] == 1
    assert result["scored"] == 1
    assert len(_scores(factory)) == 1


def test_no_completed_reviews_is_an_empty_run_not_an_error(factory) -> None:
    assert eval_worker.compute_eval_scores_task() == {
        "scored": 0, "skipped": 0, "failed": 0,
    }
