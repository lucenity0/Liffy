"""How ``Settings`` gets its values, before any runtime override is involved.

The override store is the *third* source and the only new one. These tests
cover the two underneath it, because they are the ones every existing key,
secret and connection string actually arrives through — and the ones a change
to this class can silently remove without failing anything else. Nothing else
in the suite would notice: the rest of the tests set attributes directly or
run under environment variables, so `.env` can stop being read entirely and
every one of them still passes.
"""

import pytest

from app.config import (
    EDITABLE_SETTINGS,
    SettingError,
    Settings,
    redact_url_credentials,
    settings,
)


def test_dotenv_is_loaded(tmp_path, monkeypatch) -> None:
    """`backend/.env` is where a real deployment keeps its keys.

    Asserted functionally rather than by reading `model_config`, because the
    failure being guarded against is precisely that the file stops being read
    while the class still looks configured — the regression that dropping the
    `Config` inner class produced. `anthropic_api_key` comes back `""` and
    every review fails to authenticate, with nothing pointing at config.
    """
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    (tmp_path / ".env").write_text(
        "ANTHROPIC_API_KEY=sk-ant-from-dotenv\nANTHROPIC_MODEL=model-from-dotenv\n"
    )
    # `env_file=".env"` resolves against the working directory, which is
    # `backend/` when the API or a worker is started.
    monkeypatch.chdir(tmp_path)

    loaded = Settings()

    assert loaded.anthropic_api_key == "sk-ant-from-dotenv"
    assert loaded.anthropic_model == "model-from-dotenv"


def test_unknown_dotenv_keys_do_not_break_boot(tmp_path, monkeypatch) -> None:
    """A .env file is read whole, and carries keys this class never declares —
    compose reads some of them too. pydantic-settings defaults to `forbid`,
    which would turn each one into a refusal to start."""
    (tmp_path / ".env").write_text(
        "ANTHROPIC_MODEL=model-from-dotenv\nSOMETHING_COMPOSE_READS=yes\n"
    )
    monkeypatch.chdir(tmp_path)

    assert Settings().anthropic_model == "model-from-dotenv"


def test_environment_outranks_dotenv(tmp_path, monkeypatch) -> None:
    """The precedence the settings page reports as "Set in .env" rests on this
    order holding: environment, then the file, then the field default."""
    (tmp_path / ".env").write_text("ANTHROPIC_MODEL=from-file\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ANTHROPIC_MODEL", "from-environment")

    assert Settings().anthropic_model == "from-environment"


# ── Redaction ─────────────────────────────────────────────────────────────────


def test_redaction_masks_only_the_password() -> None:
    assert (
        redact_url_credentials("postgresql://liffy:liffy@postgres:5432/liffy")
        == "postgresql://liffy:***@postgres:5432/liffy"
    )
    # No user, password only — the form a Redis URL usually takes.
    assert redact_url_credentials("redis://:pw@redis:6379/0") == "redis://***@redis:6379/0"


def test_redaction_leaves_credential_free_values_untouched() -> None:
    for value in (
        "postgresql://localhost/liffy",
        "redis://localhost:6379/0",
        "http://localhost:5173",
        "chroma",
        8000,
    ):
        assert redact_url_credentials(value) == value


# ── #298: where the endpoint field is allowed to point ────────────────────────


def _endpoint_spec():
    return EDITABLE_SETTINGS["openai_base_url"]


@pytest.mark.parametrize(
    "value",
    [
        "http://localhost:11434/v1",
        "http://127.0.0.1:11434/v1",
        "http://host.docker.internal:11434/v1",
        "https://api.openai.com/v1",
        "https://generativelanguage.googleapis.com/v1beta/openai/",
        "",  # empty is a real value: "use the provider's own default"
    ],
)
def test_the_documented_endpoints_still_save(value) -> None:
    """The allowlist has to cover everything `.env.example` tells people to use.

    An allowlist that refuses the configurations the docs recommend is not a
    control, it is a bug report waiting to be filed.
    """
    assert _endpoint_spec().parse(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "https://evil.example/v1",
        # Contains an allowlisted name and is not an allowlisted host. This is
        # why the check parses the URL instead of matching substrings.
        "https://api.openai.com.evil.example/v1",
        "https://evil.example/?x=localhost",
        # No scheme, so nothing to reason about.
        "not-a-url",
        "file:///etc/passwd",
    ],
)
def test_a_novel_endpoint_is_refused(value) -> None:
    with pytest.raises(SettingError):
        _endpoint_spec().parse(value)


def test_dotenv_can_widen_the_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    """The escape hatch, and the reason it lives in `.env`.

    Somebody running a self-hosted vLLM has a legitimate host nobody could have
    predicted. Making that a settings-page field would mean a write that wanted
    a new host could simply permit itself first; `.env` costs filesystem access
    to the box.
    """
    with pytest.raises(SettingError):
        _endpoint_spec().parse("https://llm.internal.example/v1")

    monkeypatch.setattr(settings, "openai_base_url_allowed", "llm.internal.example")
    assert _endpoint_spec().parse("https://llm.internal.example/v1")


def test_the_check_reaches_a_hand_written_row(monkeypatch: pytest.MonkeyPatch) -> None:
    """`parse` is the only path from stored text to a live value.

    That is what makes this total rather than a validator on one endpoint: a
    row inserted straight into the `settings` table with psql goes through the
    same check on the next `load_overrides`, so a direct INSERT is not a way
    around the allowlist.
    """
    assert _endpoint_spec().host_allowlisted is True
