import uuid

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

import app.models  # noqa: F401  -- register all tables on Base.metadata
from app.database import Base
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.review_comment import ReviewComment
from app.models.user import User


def test_user_roundtrip() -> None:
    # In-memory SQLite keeps this test independent of Postgres (CI has no DB).
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)

    with Session(engine) as session:
        session.add(User(github_id=12345, username="octocat", email="octocat@example.com"))
        session.commit()

        fetched = session.scalar(select(User).where(User.username == "octocat"))
        assert fetched is not None
        assert isinstance(fetched.id, uuid.UUID)
        assert fetched.github_id == 12345
        assert fetched.created_at is not None


def test_all_tables_registered() -> None:
    expected = {
        "users",
        "refresh_tokens",
        "repositories",
        "pull_requests",
        "reviews",
        "review_comments",
        "comment_feedback",
        "repo_embeddings",
        "eval_scores",
    }
    assert expected <= set(Base.metadata.tables)


def test_review_comment_confidence_and_scenario_default_to_null() -> None:
    """A comment written without either field persists with both null.

    Null is the state of every row that predates them, which is most of the
    table — so it has to be reachable by simply not passing them, not just by
    passing None explicitly. A `NOT NULL` or a server default slipped into the
    migration would fail this rather than silently backfilling a value nobody
    measured.
    """
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)

    with Session(engine) as session:
        user = User(github_id=42, username="octocat", email="octocat@example.com")
        session.add(user)
        session.flush()
        repo = Repository(user_id=user.id, github_repo_id=1, full_name="octocat/liffy")
        session.add(repo)
        session.flush()
        pr = PullRequest(
            repo_id=repo.id,
            github_pr_number=7,
            title="Add a thing",
            author="octocat",
            base_branch="main",
            head_branch="feat/thing",
        )
        session.add(pr)
        session.flush()
        review = Review(pr_id=pr.id)
        session.add(review)
        session.flush()

        session.add(
            ReviewComment(
                review_id=review.id,
                file_path="backend/app/main.py",
                line_start=1,
                line_end=2,
                category="security",
                severity="warning",
                comment_text="Validate input.",
            )
        )
        session.commit()

        fetched = session.scalar(select(ReviewComment))
        assert fetched is not None
        assert fetched.confidence is None
        assert fetched.failure_scenario is None


def test_review_comment_stores_confidence_and_scenario() -> None:
    """And when they are given, they round-trip unchanged."""
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)

    with Session(engine) as session:
        user = User(github_id=43, username="hubot", email="hubot@example.com")
        session.add(user)
        session.flush()
        repo = Repository(user_id=user.id, github_repo_id=2, full_name="hubot/liffy")
        session.add(repo)
        session.flush()
        pr = PullRequest(
            repo_id=repo.id,
            github_pr_number=8,
            title="Add another thing",
            author="hubot",
            base_branch="main",
            head_branch="feat/other",
        )
        session.add(pr)
        session.flush()
        review = Review(pr_id=pr.id)
        session.add(review)
        session.flush()

        session.add(
            ReviewComment(
                review_id=review.id,
                file_path="backend/app/main.py",
                line_start=1,
                line_end=2,
                category="logic_error",
                severity="critical",
                comment_text="Off by one.",
                confidence="plausible",
                failure_scenario="With an empty list, the loop reads index -1.",
            )
        )
        session.commit()

        fetched = session.scalar(select(ReviewComment))
        assert fetched is not None
        assert fetched.confidence == "plausible"
        assert fetched.failure_scenario == "With an empty list, the loop reads index -1."
