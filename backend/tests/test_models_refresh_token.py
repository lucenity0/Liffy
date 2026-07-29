import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import app.models  # noqa: F401  -- register all tables on Base.metadata
from app.database import Base
from app.models.refresh_token import RefreshToken
from app.models.user import User

# A SHA-256 hex digest is what the column actually stores; using real ones here
# keeps the fixtures honest about the 64-character width.
HASH_A = "a" * 64
HASH_B = "b" * 64


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://", future=True)

    # SQLite ignores ON DELETE CASCADE unless foreign keys are switched on per
    # connection. Without this the cascade test passes vacuously — the delete
    # succeeds and the orphan row simply stays behind.
    @event.listens_for(engine, "connect")
    def _enable_sqlite_fks(dbapi_connection, _record):  # type: ignore[no-untyped-def]
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


@pytest.fixture()
def user(db: Session) -> User:
    user = User(github_id=1, username="octo")
    db.add(user)
    db.flush()
    return user


def _token(user: User, token_hash: str, **overrides: object) -> RefreshToken:
    values: dict = {
        "user_id": user.id,
        "token_hash": token_hash,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=30),
    }
    values.update(overrides)
    return RefreshToken(**values)


def test_refresh_token_defaults(db: Session, user: User) -> None:
    db.add(_token(user, HASH_A))
    db.commit()

    fetched = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == HASH_A))
    assert fetched is not None
    assert isinstance(fetched.id, uuid.UUID)
    assert fetched.revoked_at is None  # not revoked until it is rotated
    assert fetched.created_at is not None


def test_refresh_token_requires_unique_hash(db: Session, user: User) -> None:
    db.add(_token(user, HASH_A))
    db.commit()

    db.add(_token(user, HASH_A))
    with pytest.raises(IntegrityError):
        db.commit()


def test_refresh_token_cascade_on_user_delete(db: Session, user: User) -> None:
    db.add_all([_token(user, HASH_A), _token(user, HASH_B)])
    db.commit()

    db.delete(user)
    db.commit()

    assert db.scalars(select(RefreshToken)).all() == []
