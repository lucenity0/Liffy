import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Index, String, Uuid, false, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class User(Base):
    """Authenticated GitHub user (report §5)."""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    github_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    username: Mapped[str] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # The user's GitHub OAuth token, stored in PLAINTEXT. This is a known and
    # accepted limitation, not an oversight.
    #
    # Encrypting it at rest is the right long-term answer, but it needs a
    # key-management story this project does not have yet — where the key
    # lives, how it is rotated, how it is supplied to the workers. A fake
    # base64 "encryption" would be worse than honest plaintext, because it
    # looks like protection while providing none.
    #
    # The mitigations that do apply: the column is never logged, never
    # serialised (UserOut lists its fields explicitly, so this one cannot
    # leak through /auth/me), and is removed with the user by FK cascade.
    github_access_token: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Whoever this instance belongs to. Exactly one row may carry it, enforced
    # by the partial unique index below rather than by hope.
    #
    # Liffy is single-tenant by design (ADR 007). This column is not the first
    # step of a role system and should not grow into one: it answers one
    # question — "is this the person who installed it?" — and the two places
    # that ask are `api/settings.py` and `api/help.py::submit_report`, both of
    # which reach outside this install.
    #
    # Claimed by the first account to complete the OAuth handshake, which is
    # what keeps a fresh clone usable with no configuration. Every later login
    # is refused unless it is the owner or sits in ALLOWED_GITHUB_LOGINS.
    is_owner: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=false(), default=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # A *partial* unique index: it constrains only the rows where `is_owner` is
    # true, so the one owner is unique while every other user stays unconstrained.
    # A plain unique index on the column would allow exactly one non-owner.
    #
    # Both dialects are named because tests run on SQLite and deployments on
    # Postgres, and a constraint that exists in only one of them is a constraint
    # the test suite cannot see.
    __table_args__ = (
        Index(
            "ix_users_single_owner",
            "is_owner",
            unique=True,
            postgresql_where=text("is_owner"),
            sqlite_where=text("is_owner"),
        ),
    )
