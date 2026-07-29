import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, String, Uuid, func
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
