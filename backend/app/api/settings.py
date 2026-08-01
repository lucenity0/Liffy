from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.config import (
    CONFIRM_ON_ENABLE,
    EDITABLE_SETTINGS,
    READ_ONLY_SETTINGS,
    SECRET_SETTINGS,
    SettingError,
    settings,
)
from app.database import get_db
from app.models.user import User
from app.schemas.setting import (
    EditableSettingOut,
    ReadOnlySettingOut,
    SecretSettingOut,
    SettingsOut,
    SettingsPatch,
)
from app.services.settings_service import (
    effective_value,
    env_value,
    load_overrides,
    update_settings,
)

router = APIRouter()


def _describe(db: Session) -> SettingsOut:
    stored = load_overrides(db)

    editable = []
    for key, spec in EDITABLE_SETTINGS.items():
        default = env_value(key)
        value = effective_value(key)
        # Three states, not two. "override" means somebody changed it here;
        # "env" means .env sets it to something other than the field default;
        # "default" means nobody has touched it. Collapsing the last two would
        # lose the answer to "is this value mine or the box's?".
        if key in stored:
            source = "override"
        elif default != type(settings).model_fields[key].default:
            source = "env"
        else:
            source = "default"

        editable.append(
            EditableSettingOut(
                key=key,
                group=spec.group,
                label=spec.label,
                help=spec.help,
                kind=spec.kind,
                choices=list(spec.choices),
                minimum=spec.minimum,
                maximum=spec.maximum,
                value=value,
                default_value=default,
                source=source,
                confirm_on_enable=key in CONFIRM_ON_ENABLE,
            )
        )

    read_only = [
        ReadOnlySettingOut(
            key=key,
            group=meta.group,
            label=meta.label,
            reason=meta.reason,
            value=getattr(settings, key),
        )
        for key, meta in READ_ONLY_SETTINGS.items()
    ]

    # `bool(...)` and never the value. The response is built here rather than
    # by serializing a settings object, so there is no path by which adding a
    # field to `Settings` accidentally publishes it.
    secrets = [
        SecretSettingOut(
            key=key,
            label=key.replace("_", " ").capitalize(),
            is_set=bool(getattr(settings, key)),
        )
        for key in SECRET_SETTINGS
    ]

    return SettingsOut(editable=editable, read_only=read_only, secrets=secrets)


@router.get("/settings", response_model=SettingsOut)
def get_settings(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SettingsOut:
    """Every setting, in the three buckets the classification defines.

    **Authenticated, but not authorized beyond that.** Liffy has no roles or
    multi-tenancy yet, so any signed-in user can read and change these. That is
    a real limitation rather than an oversight — inventing a role system here
    would be a larger change than the feature — and it is worth knowing before
    Liffy is deployed anywhere with more than one person on it.
    """
    return _describe(db)


@router.patch("/settings", response_model=SettingsOut)
def patch_settings(
    payload: SettingsPatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SettingsOut:
    """Change one or more editable settings.

    Rejects unknown and non-editable keys with 422 rather than storing them
    silently: a write that reports success and does nothing is the worst
    possible behaviour for the page that is supposed to answer "where is this
    configured?".

    Validation runs over the whole batch before anything is written, so a
    request naming one good key and one bad one changes neither and the form
    cannot end up disagreeing with itself about what saved.

    Returns the full settings document, so the client re-renders from the
    server's view rather than from an optimistic guess about what it just did.
    """
    try:
        update_settings(db, payload.values, user.id)
    except SettingError as exc:
        # 422 with the offending message, so the frontend can put it on the
        # field instead of raising a page-level error over one bad character.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _describe(db)
