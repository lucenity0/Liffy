import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, SmallInteger, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CommentFeedback(Base):
    """Per-comment user rating (report §5). rating is 1 (thumbs up) or -1 (thumbs down)."""

    __tablename__ = "comment_feedback"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    comment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("review_comments.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    rating: Mapped[int] = mapped_column(SmallInteger)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
