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
    # Offered in the UI without closing the field — unlike `choices`, a value
    # outside this list is still valid. See `SettingSpec.suggestions`.
    suggestions: list[str]
    # The `llm_provider` values this setting matters for; empty means always.
    # Lets the page show one model field instead of four, three of which do
    # nothing for the provider that is actually selected.
    applies_to: list[str]
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
    # What "not configured" means for this one. Without it the page reports a
    # key nobody needs and a key the review depends on in identical words.
    requirement: str
    # The `llm_provider` values this credential matters for; empty means always.
    applies_to: list[str]
    # True when the page can set this one, rather than only report on it.
    connectable: bool
    # The command that produces the value, shown in the connect dialog.
    connect_command: str
    is_set: bool
    # Where the value comes from — the same three states the editable settings
    # report, and for the same reason.
    #
    # `is_set` alone cannot answer "can I disconnect this?". A credential set in
    # `backend/.env` and one connected from this page both read as set, so the
    # page offered Disconnect for a `.env` value, the request deleted a row that
    # was not there, and the badge came back unchanged — a button that looked
    # broken while doing exactly what it was asked. Worse, a `.env` token could
    # not be replaced from the page at all, because Connect only appeared when
    # nothing was set.
    source: Source


class SecretConnect(BaseModel):
    """A credential submitted from the settings page.

    Write-only in both directions: it arrives here and is never echoed back —
    the settings document reports `is_set` and nothing else, before and after.
    """

    value: str


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
