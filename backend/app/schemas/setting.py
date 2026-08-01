from typing import Any, Literal

from pydantic import BaseModel

Source = Literal["default", "env", "override"]


class EditableSettingOut(BaseModel):
    """One setting the UI may change.

    ``source`` is what makes the page explanatory rather than just a form: it
    answers *where this value came from*, which is the question a newcomer
    actually has. ``default_value`` rides along so "changed here" can show what
    it was changed from without a second request.
    """

    key: str
    group: str
    label: str
    help: str
    kind: str
    choices: list[str]
    minimum: int | None
    maximum: int | None
    value: Any
    default_value: Any
    source: Source
    # Enabling these reaches outside Liffy — one writes to somebody's pull
    # request, the other can block their merge — so the UI must confirm first.
    confirm_on_enable: bool


class ReadOnlySettingOut(BaseModel):
    """Visible, explained, not editable.

    The read-only half is a feature, not a consolation: it answers "where is
    this configured?" without inviting a change that could not take effect.
    ``reason`` is rendered next to the control, so it says *why* rather than
    only that the field is disabled.
    """

    key: str
    group: str
    label: str
    reason: str
    value: Any


class SecretSettingOut(BaseModel):
    """A secret's *existence*, and nothing else.

    No value, no masked value, no length — a mask still leaks the length, and
    a length is a meaningful hint about a token. ``is_set`` is the entire
    contract, and `test_secrets_never_appear_in_response` asserts it against
    the whole serialized body rather than field by field.
    """

    key: str
    label: str
    is_set: bool


class SettingsOut(BaseModel):
    editable: list[EditableSettingOut]
    read_only: list[ReadOnlySettingOut]
    secrets: list[SecretSettingOut]


class SettingsPatch(BaseModel):
    """A partial update: only the keys present are touched.

    Values arrive as strings whatever their type, because that is what the
    stored form is and it keeps one parser — ``SettingSpec.parse`` — as the
    single path from text to a live value. A JSON `true` and the string
    `"true"` would otherwise take different routes to the same column.
    """

    values: dict[str, str]
