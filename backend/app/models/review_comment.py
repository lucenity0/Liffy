import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ReviewComment(Base):
    """An individual inline comment within a review (report §5).

    ``category`` and ``severity`` are stored as strings; the allowed values are
    validated at the app boundary by the Pydantic schema (see ``schemas/review.py``).
    """

    __tablename__ = "review_comments"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    review_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("reviews.id", ondelete="CASCADE"), index=True
    )
    file_path: Mapped[str] = mapped_column(String(1024))
    line_start: Mapped[int] = mapped_column(Integer)
    line_end: Mapped[int] = mapped_column(Integer)
    category: Mapped[str] = mapped_column(String(32))
    severity: Mapped[str] = mapped_column(String(16))
    comment_text: Mapped[str] = mapped_column(Text)
    suggestion: Mapped[str | None] = mapped_column(Text, nullable=True)

    # How sure the model is that the finding is real, as opposed to how bad it
    # would be if it were — ``severity`` answers only the second. ``confirmed``
    # when the model can name the inputs or state that trigger it, ``plausible``
    # when the mechanism is real but the trigger is not.
    #
    # Nullable, and null is not a third value: it means the review predates the
    # field or the model returned the older output shape. Every row written
    # before this column existed is in that state, and a server default would
    # have written a confidence nobody ever elicited.
    confidence: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # The concrete inputs or state that make the finding bite, and the wrong
    # result they produce. ``Text`` like ``comment_text``, because it is the
    # same thing: model prose of no fixed length.
    #
    # Untrusted at the render boundary — it derives from a diff someone else
    # wrote — so anything putting it into a GitHub body must defang it first.
    failure_scenario: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
