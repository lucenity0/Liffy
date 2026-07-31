import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class EvalScore(Base):
    """Computed quality metrics per review (report §5, §8).

    **One row per review, updated in place.** The weekly beat job upserts
    rather than inserts; without the constraint below a naive insert grows a
    new row every Monday and "the latest score" becomes
    ``ORDER BY computed_at DESC LIMIT 1`` forever, in every caller.

    Append-only history was the alternative and was rejected: §8.1's trend
    metric is a fleet-wide average over time, which #194 computes from
    ``reviews.created_at`` without needing a per-review series. Keeping history
    here would buy a graph nobody asked for and make every read need a window
    function.

    Both rates are ``NOT NULL``, which is why the job **skips** reviews with no
    feedback rather than writing a fabricated ``0.0`` for them. No feedback is
    not a score.
    """

    __tablename__ = "eval_scores"
    __table_args__ = (UniqueConstraint("review_id", name="uq_eval_scores_review"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    review_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("reviews.id", ondelete="CASCADE"), index=True
    )
    approval_rate: Mapped[float] = mapped_column(Float)
    false_positive_rate: Mapped[float] = mapped_column(Float)
    # Report §8.2: "reviews with approval rate below 50% are flagged for manual
    # inspection". Recorded at scoring time rather than derived at read time so
    # the flag is a fact with a timestamp beside it, and so the threshold lives
    # in one place instead of being re-applied — possibly differently — by each
    # caller. See LOW_APPROVAL_THRESHOLD in eval_service.
    flagged: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
