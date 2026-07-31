import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, SmallInteger, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CommentFeedback(Base):
    """Per-comment user rating (report §5). rating is 1 (thumbs up) or -1 (thumbs down).

    One row per (comment, user): a user who clicks thumbs-up and then
    thumbs-down ends with a single row at ``-1``, not two rows that cancel.
    Without the constraint one indecisive click makes every approval rate
    computed off this table permanently wrong, and nothing would ever say so.

    Per *pair*, not per comment — two users rating the same comment is the
    normal case and both ratings count.
    """

    __tablename__ = "comment_feedback"
    __table_args__ = (
        UniqueConstraint("comment_id", "user_id", name="uq_comment_feedback_comment_user"),
    )

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
