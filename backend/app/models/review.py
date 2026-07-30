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
    # placement inside it can capture that. ``total_ms`` below is that figure;
    # this is the pipeline inside it.
    #
    # Milliseconds as an int rather than seconds as a float — the report talks
    # in seconds, but a float invites formatting bugs at display time and this
    # stores exactly.
    #
    # Nullable, and deliberately not backfilled: rows written before this
    # existed genuinely have no measurement, and inventing one would poison
    # the first analysis that reads the column.
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # **Report §8.1's time-to-review**: webhook receipt -> review written,
    # against the < 90s target. Where ``duration_ms`` is a lower bound, this is
    # the number the report promises.
    #
    # Wall clock unavoidably, unlike ``duration_ms``: the two ends are measured
    # in different processes — receipt in the API, completion in the worker —
    # and ``time.monotonic()`` is only comparable within one. So METRIC-1's
    # warning about NTP corrections applies here, and the two hosts can also
    # simply disagree. Clamped at 0 rather than stored negative; see
    # ``_wall_clock_ms`` in review_service.
    #
    # Queue wait is ``total_ms - duration_ms`` — the number that says whether a
    # missed target is Liffy's pipeline or the broker's backlog. Deliberately
    # not stored: both operands are nullable and measured by different clocks,
    # so a stored column would have to either ship a small negative or clamp
    # away the evidence of skew.
    #
    # NULL for manual triggers and re-reviews — there is no webhook receipt,
    # and it does **not** fall back to ``duration_ms``. Reporting a pipeline
    # duration as an end-to-end one is the exact confusion this column exists
    # to remove.
    total_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    # When the webhook delivery was received, stamped in the API process.
    #
    # Written when the ``processing`` row is first created rather than at
    # completion, so a review whose worker is killed — or which sits in
    # ``processing`` forever — still records when it was asked for. That is
    # exactly the case where queue wait is worth knowing.
    queued_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
