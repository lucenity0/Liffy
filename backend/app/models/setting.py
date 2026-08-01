import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Setting(Base):
    """A runtime override for one entry in ``app.config.Settings``.

    Sparse on purpose: a row exists only for a setting somebody has actually
    changed. Absent means "whatever ``.env`` or the field default says", which
    is what makes the resolver's precedence — DB row, then env, then default —
    expressible without storing every key up front.

    **A row here is not authority on its own.** The resolver honours a key only
    if it is on ``EDITABLE_SETTINGS``; a row for ``database_url`` is ignored,
    not applied. The table is writable by any authenticated user through
    ``PATCH /settings``, so treating its contents as trusted would turn one
    unvalidated write into an arbitrary reconfiguration.

    ``.env`` is deliberately never rewritten. It is bind-mounted in compose,
    sometimes read-only, and often holds values set by hand that no process
    should be clobbering.
    """

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    # Text rather than JSON: the eight editable settings are strings, ints and
    # bools, and the spec that declares each one already knows how to read its
    # own type back. Storing `"medium"` rather than `"\"medium\""` keeps the
    # table legible to anyone looking at it in psql during an incident.
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    # Nullable, and SET NULL on delete: who changed a setting is useful history,
    # but not so useful that deleting a user should be blocked by it — or that
    # losing the attribution should take the setting itself with it.
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
