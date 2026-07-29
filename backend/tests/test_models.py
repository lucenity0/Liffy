import uuid

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

import app.models  # noqa: F401  -- register all tables on Base.metadata
from app.database import Base
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
