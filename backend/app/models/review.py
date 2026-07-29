import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Review(Base):
    """One review per PR trigger (report §5). status: pending/processing/completed/failed."""

    __tablename__ = "reviews"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    pr_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("pull_requests.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    raw_diff: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    verdict: Mapped[str | None] = mapped_column(String(32), nullable=True)
    model_used: Mapped[str | None] = mapped_column(String(128), nullable=True)
    tokens_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Wall-clock milliseconds for ``run_review``: the whole pipeline, from
    # the first GitHub call to the review being written.
    #
    # **A lower bound on report §8.1's time-to-review, not that figure.** §8.1
    # measures webhook received -> review complete against a < 90s target, but
    # the webhook only enqueues a Celery task (``review_pr_task.delay``), so
    # queue wait happens entirely before this function is called and no
    # placement inside it can capture that. Checking the §8.1 target needs a
    # timestamp taken at webhook receipt and threaded through the task.
    #
    # Milliseconds as an int rather than seconds as a float — the report talks
    # in seconds, but a float invites formatting bugs at display time and this
    # stores exactly.
    #
    # Nullable, and deliberately not backfilled: rows written before this
    # existed genuinely have no measurement, and inventing one would poison
    # the first analysis that reads the column.
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
