import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Repository(Base):
    """A GitHub repository connected to Liffy (report §5)."""

    __tablename__ = "repositories"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    github_repo_id: Mapped[int] = mapped_column(BigInteger, index=True)
    full_name: Mapped[str] = mapped_column(String(512))  # "owner/repo"
    default_branch: Mapped[str] = mapped_column(String(255), default="main")
    indexed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # How the **last** index run went, so a partial index is distinguishable
    # from a complete one.
    #
    # ``IndexResult.files_failed`` counted these already, but it reached
    # nobody: the Celery result dict goes to a backend nothing reads, and the
    # only other trace is a ``logger.exception`` in the worker log. A run where
    # 40 of 200 files were skipped rendered as "Indexed · 160 chunks · just
    # now" — identical to a complete index except by a chunk count nobody has a
    # baseline for. Reviews touching those 40 files then retrieve no context
    # and quietly get worse, with nothing anywhere saying why.
    #
    # ``last_indexed_files_seen`` is the denominator. "40 skipped" means
    # something different out of 45 than out of 4,000, and without it the count
    # cannot be read.
    #
    # **Last run, not cumulative.** Both are overwritten on every run, so a
    # later clean run clears the caveat rather than carrying a failure forward
    # forever.
    #
    # Nullable because every row already in the database predates them, and a
    # legacy repository has genuinely never recorded this — which is different
    # from having recorded a zero.
    last_index_failed_files: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_indexed_files_seen: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
