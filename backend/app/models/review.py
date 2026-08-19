import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
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
    # The structured half of the overview: `{"changes": [...], "files": [...]}`.
    #
    # Kept separate from `summary` because `summary` is the one-line preview in
    # the reviews list, where markdown headings and table pipes would render as
    # syntax. JSON rather than columns: the shape is presentational and expected
    # to move, and a migration per field is a poor trade for a payload nothing
    # queries. Null on reviews written before this landed.
    summary_detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # The raw provider output behind a failure, kept out of `summary`.
    #
    # `summary` is the line the reviews list renders for every review, so a
    # failure's technical detail welded onto it put three hundred characters of
    # `{"is_error": true, "duration_api_ms": ...}` on screen next to ordinary
    # review descriptions. Here it can sit behind a disclosure instead, in
    # full, without a cap chosen for a preview line.
    failure_detail: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Whether the person reading can do anything about it. The values are
    # spelled once in `chain.FAILURE_KIND` rather than constrained here,
    # because the LLM providers own the taxonomy and a check constraint would
    # need a migration every time one learns a new failure.
    #
    # `unknown` is the load-bearing value: it is what tells the UI to offer a
    # bug report instead of advice, because nothing it could advise would help.
    failure_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # The commit this review actually looked at.
    #
    # A later review of the same pull request diffs *from* here rather than
    # from the base branch, so pushing one commit to a large PR costs one
    # commit's worth of review instead of the whole thing again.
    #
    # Null means "no idea what this one saw" — true of every row written before
    # this existed — which correctly falls back to reviewing the whole diff.
    head_sha: Mapped[str | None] = mapped_column(String(40), nullable=True)

    verdict: Mapped[str | None] = mapped_column(String(32), nullable=True)
    model_used: Mapped[str | None] = mapped_column(String(128), nullable=True)
    tokens_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Wall-clock milliseconds for ``run_review`` — the whole pipeline.
    #
    # A *lower bound* on report §8.1's time-to-review, not that figure: the
    # webhook only enqueues a Celery task, so queue wait happens entirely before
    # this function is entered and no placement inside it can capture that.
    # ``total_ms`` below is §8.1's number.
    #
    # Nullable and deliberately not backfilled — rows written before this column
    # existed have no measurement, and inventing one would poison the first
    # analysis that reads it.
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # **Report §8.1's time-to-review**: webhook receipt -> review written,
    # against the < 90s target.
    #
    # Wall clock unavoidably, unlike ``duration_ms``: the two ends are measured
    # in different processes, and ``time.monotonic()`` is only comparable within
    # one. So clock skew between hosts applies. Clamped at 0 rather than stored
    # negative; see ``_wall_clock_ms`` in review_service.
    #
    # Queue wait is ``total_ms - duration_ms``, deliberately not stored: both
    # operands are nullable and measured by different clocks, so a column would
    # have to ship a small negative or clamp away the evidence of skew.
    #
    # NULL for manual triggers and re-reviews, and it does **not** fall back to
    # ``duration_ms`` — reporting a pipeline duration as an end-to-end one is
    # the exact confusion this column exists to remove.
    total_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # ── Delivery to GitHub (GH-2) ────────────────────────────────────────────
    #
    # All four are NULL until a review is posted, which is the default: posting
    # is opt-in (``post_reviews_to_github``, default False).
    #
    # ``github_review_id`` doubles as the idempotency guard. Re-review creates a
    # *new* Review row and ``synchronize`` webhooks fire on every push, so
    # without a per-row guard a PR pushed to five times accumulates five
    # duplicate review threads.
    github_review_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    github_review_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    posted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Why the last attempt failed. A failure that is merely *absent* is
    # indistinguishable from never having tried, and the point of not failing
    # the review on a posting error is that somebody can still find out it
    # happened. Truncated before storing — GitHub's validation bodies are long.
    post_error: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    # When the webhook delivery was received, stamped in the API process.
    #
    # Written when the ``processing`` row is created rather than at completion,
    # so a review whose worker is killed still records when it was asked for —
    # exactly the case where queue wait is worth knowing.
    queued_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
