import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Uuid,
    false,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PullRequest(Base):
    """A pull request Liffy has processed (report §5)."""

    __tablename__ = "pull_requests"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    repo_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("repositories.id", ondelete="CASCADE"), index=True
    )
    github_pr_number: Mapped[int] = mapped_column(Integer, index=True)
    title: Mapped[str] = mapped_column(String(1024))
    author: Mapped[str] = mapped_column(String(255))
    base_branch: Mapped[str] = mapped_column(String(255))
    head_branch: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32), default="open")

    # Whether a push to this pull request reviews it automatically.
    #
    # Off by default, deliberately. `synchronize` fires on every push, so
    # applying three of Liffy's own suggestions used to cost three full
    # reviews — and on a subscription that is rate-limit quota, spent without
    # anyone asking. The first review on `opened` is unaffected; this governs
    # only what happens afterwards.
    #
    # Per pull request, not per repository: the risk is per pull request. It
    # depends whose PR it is and how active the author is, and a repo-wide
    # switch cannot say "automatic on mine, never on the one where somebody is
    # pushing forty commits".
    auto_review: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
