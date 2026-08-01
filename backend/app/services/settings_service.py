"""Runtime settings: reading overrides out of the database and back into config.

Precedence, in one place and one direction:

    database row  →  environment / .env  →  the field's default

The middle and last steps are pydantic's, already. This module only owns the
first, plus the rule that decides whether a row counts at all.

**A row is not authority.** ``PATCH /settings`` is open to any authenticated
user, so the table is only as trustworthy as the weakest write to it. Every
read filters through ``EDITABLE_SETTINGS`` and every value goes through the
same ``SettingSpec.parse`` a PATCH would use — a row for ``database_url``, or
an ``anthropic_effort`` of ``"ludicrous"`` hand-inserted with psql, is dropped
on load rather than applied.
"""

import uuid
from typing import Any

import structlog
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import (
    EDITABLE_SETTINGS,
    SettingError,
    apply_overrides,
    settings,
)
from app.models.setting import Setting

log = structlog.get_logger(__name__)


def load_overrides(db: Session) -> dict[str, Any]:
    """Every stored override that is allowed and parses, as live values.

    Anything else is skipped with a warning rather than raising: one bad row
    must not be able to stop the API booting, and a setting that silently
    reverts to its env value is a far better failure than a process that will
    not start.
    """
    resolved: dict[str, Any] = {}
    for row in db.scalars(select(Setting)):
        spec = EDITABLE_SETTINGS.get(row.key)
        if spec is None:
            # Not on the allowlist. Being in the database is not a promotion.
            log.warning("settings.row_not_editable", key=row.key)
            continue
        try:
            resolved[row.key] = spec.parse(row.value)
        except SettingError as exc:
            log.warning("settings.row_invalid", key=row.key, error=str(exc))
    return resolved


def refresh_overrides(db: Session) -> dict[str, Any]:
    """Reload the store from the database and return what is now live.

    Called on write in the API process, and at the start of each review task in
    the worker — see ``workers.review_worker``. Those are the only two callers,
    and between them they are why a change made in the UI applies to the *next*
    review rather than after a restart.
    """
    resolved = load_overrides(db)
    apply_overrides(resolved)
    return resolved


def effective_value(key: str) -> Any:
    """What ``settings.<key>`` currently reads as, override included."""
    return getattr(settings, key)


def env_value(key: str) -> Any:
    """The value ignoring any override — what ``.env`` or the default says.

    ``BaseSettings`` keeps field values in ``__dict__``, so this reads beneath
    the ``__getattribute__`` hook rather than through it. That is what lets the
    UI say *where a value came from* instead of only what it is, which is the
    difference between a settings page and a form.
    """
    return object.__getattribute__(settings, "__dict__")[key]


def update_settings(
    db: Session, updates: dict[str, str], user_id: uuid.UUID | None
) -> dict[str, Any]:
    """Validate, persist and re-apply a partial settings change.

    Unknown and non-editable keys raise rather than being ignored: a write that
    reports success and stores nothing is the worst outcome for a page whose
    entire job is telling you where configuration lives.

    A value equal to the env/default is stored as a *deletion*. Otherwise
    "change it back" would leave a row that pins the value even after somebody
    later edits ``.env``, and the page would keep reporting "changed here" for
    a setting nobody is overriding any more.
    """
    parsed: dict[str, Any] = {}
    for key, raw in updates.items():
        spec = EDITABLE_SETTINGS.get(key)
        if spec is None:
            raise SettingError(f"{key!r} is not an editable setting.")
        parsed[key] = spec.parse(raw)

    # Validated as a set before anything is written, so a request that names
    # one good key and one bad one changes neither.
    for key, value in parsed.items():
        spec = EDITABLE_SETTINGS[key]
        if value == env_value(key):
            db.execute(delete(Setting).where(Setting.key == key))
            continue
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=spec.serialize(value), updated_by=user_id))
        else:
            row.value = spec.serialize(value)
            row.updated_by = user_id

    db.commit()
    # Invalidate immediately rather than on a TTL: "I changed it and nothing
    # happened" for however long the TTL lasts is exactly the confusion this
    # feature exists to remove.
    return refresh_overrides(db)
