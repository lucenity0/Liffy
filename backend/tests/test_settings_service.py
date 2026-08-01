import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.config import EDITABLE_SETTINGS, SettingError, apply_overrides, settings
from app.database import Base
from app.models.setting import Setting
from app.services.settings_service import (
    env_value,
    load_overrides,
    refresh_overrides,
    update_settings,
)


@pytest.fixture()
def db():
    """A database, plus a guarantee that the override store is empty again.

    The store is process-global — it is the thing every call site reads
    through — so a test that writes a setting and does not clear it would
    silently reconfigure every test that runs after it.
    """
    engine = create_engine(
        "sqlite://", future=True, connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)
    with factory() as session:
        yield session
    apply_overrides({})


def test_precedence_db_over_env_over_default(db) -> None:
    # No row: the field default stands.
    assert settings.anthropic_effort == "medium"

    update_settings(db, {"anthropic_effort": "high"}, None)

    # Row present: it wins, and it wins through the ordinary attribute read
    # every call site already uses — not through a special accessor.
    assert settings.anthropic_effort == "high"
    # ...while the underlying env/default value is still there to be reported.
    assert env_value("anthropic_effort") == "medium"


def test_codex_effort_defaults_locally_instead_of_cli_config(db) -> None:
    assert settings.codex_effort == "medium"

    update_settings(db, {"codex_effort": "high"}, None)

    assert settings.codex_effort == "high"


def test_override_is_visible_to_an_existing_call_site(db, monkeypatch) -> None:
    """The point of the whole exercise, asserted where it actually matters.

    `get_llm` reads `settings.llm_provider` inside the function and is not
    aware this feature exists. If the hook only worked through the settings
    service, this would still hand back the Anthropic transport.

    The key is set with monkeypatch rather than through `update_settings`,
    because an API key is a secret and therefore *not* editable — setting the
    attribute directly is what having it in `.env` looks like.
    """
    from app.llm.chain import OpenAIReviewLLM, get_llm

    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    update_settings(db, {"llm_provider": "openai"}, None)

    assert isinstance(get_llm(), OpenAIReviewLLM)


def test_non_allowlisted_key_rejected(db) -> None:
    with pytest.raises(SettingError):
        update_settings(db, {"database_url": "postgresql://evil/db"}, None)

    assert db.query(Setting).count() == 0


def test_db_row_for_forbidden_key_is_ignored_by_resolver(db) -> None:
    """A row is not authority just because it is in the database.

    Inserted directly, bypassing the API entirely — which is the threat model:
    the table is writable by any authenticated user, so the resolver has to be
    the thing that refuses, not only the endpoint.
    """
    db.add(Setting(key="database_url", value="postgresql://evil/db"))
    db.add(Setting(key="jwt_secret_key", value="hunter2"))
    db.commit()

    resolved = refresh_overrides(db)

    assert resolved == {}
    assert settings.database_url != "postgresql://evil/db"
    assert settings.jwt_secret_key != "hunter2"


def test_unparseable_row_is_skipped_rather_than_crashing(db) -> None:
    """One bad row must not stop the process booting."""
    db.add(Setting(key="anthropic_effort", value="ludicrous"))
    db.add(Setting(key="llm_max_tokens", value="20000"))
    db.commit()

    resolved = load_overrides(db)

    # The good row still applies; the bad one falls back to its env value.
    assert resolved == {"llm_max_tokens": 20000}


def test_invalid_effort_rejected(db) -> None:
    with pytest.raises(SettingError, match="low, medium, high, xhigh, max"):
        update_settings(db, {"anthropic_effort": "ludicrous"}, None)


def test_max_tokens_floor_rejected(db) -> None:
    # A 500-token cap truncates every review mid-JSON and reads as a parser bug.
    with pytest.raises(SettingError, match="at least 4000"):
        update_settings(db, {"llm_max_tokens": "500"}, None)


def test_a_partial_failure_writes_nothing(db) -> None:
    """One bad key in a batch rolls the whole batch back.

    Otherwise a form submitting four fields could apply three and reject one,
    leaving the page disagreeing with itself about what was saved.
    """
    with pytest.raises(SettingError):
        update_settings(
            db, {"anthropic_effort": "high", "llm_max_tokens": "12"}, None
        )

    assert db.query(Setting).count() == 0
    assert settings.anthropic_effort == "medium"


def test_booleans_round_trip_including_false(db) -> None:
    """`False` is the trap: a truth-test in the override store would let it
    fall through to the env value, and the toggle would refuse to turn off."""
    update_settings(db, {"post_reviews_to_github": "true"}, None)
    assert settings.post_reviews_to_github is True

    update_settings(db, {"post_reviews_to_github": "false"}, None)
    assert settings.post_reviews_to_github is False


def test_setting_a_value_back_to_the_default_removes_the_row(db) -> None:
    """Otherwise the row pins the value even after somebody edits .env, and
    the page keeps reporting "changed here" for a setting nobody overrides."""
    update_settings(db, {"anthropic_effort": "high"}, None)
    assert db.query(Setting).count() == 1

    update_settings(db, {"anthropic_effort": "medium"}, None)

    assert db.query(Setting).count() == 0
    assert settings.anthropic_effort == "medium"


def test_every_editable_setting_names_a_real_field() -> None:
    """Guards the classification against drift.

    A typo, or a field renamed in `Settings` without the allowlist following,
    would otherwise produce a control that silently does nothing.
    """
    fields = type(settings).model_fields
    for key in EDITABLE_SETTINGS:
        assert key in fields, f"{key} is on the allowlist but not a Settings field"


def test_every_provider_has_exactly_one_model_field(db) -> None:
    """The asymmetry this replaced: three model boxes, and none for codex.

    Each provider gets one editable model setting scoped to it, so the page can
    render a single control instead of four with three inert.
    """
    from app.config import EDITABLE_SETTINGS as specs

    for provider in specs["llm_provider"].choices:
        owned = [
            key
            for key, spec in specs.items()
            if key.endswith("_model") and provider in spec.applies_to
        ]
        assert len(owned) == 1, f"{provider} owns {owned}"


def test_suggestions_do_not_close_the_field(db) -> None:
    """`suggestions` is advisory — `choices` is the one that validates.

    Load-bearing for `openai`, which also drives Ollama and Gemini: a closed
    list would reject the model names those endpoints actually serve.
    """
    from app.config import EDITABLE_SETTINGS as specs

    assert "qwen2.5-coder:14b" not in specs["openai_model"].suggestions[:1]
    update_settings(db, {"openai_model": "some-local-model:70b"}, None)
    assert settings.openai_model == "some-local-model:70b"


def test_codex_model_accepts_empty_meaning_cli_default(db) -> None:
    """Empty is a real answer here, not a missing one.

    Codex slugs are version- and account-specific, so "use whatever
    ~/.codex/config.toml says" is both the default and a choice someone may
    need to return to after trying an explicit slug.
    """
    update_settings(db, {"codex_model": "gpt-5.6-luna"}, None)
    assert settings.codex_model == "gpt-5.6-luna"

    update_settings(db, {"codex_model": ""}, None)
    assert settings.codex_model == ""
    # Back to the default, so the row goes rather than pinning the value.
    assert db.query(Setting).count() == 0


def test_other_str_settings_still_reject_empty(db) -> None:
    """`allow_empty` is per setting — an empty Anthropic model is a mistake."""
    with pytest.raises(SettingError, match="Cannot be empty"):
        update_settings(db, {"anthropic_model": "   "}, None)


def test_subscription_token_is_secret_not_editable(db) -> None:
    """A subscription token is a credential and must behave like one.

    It is long-lived, it is not revocable from inside Liffy, and revoking it
    means re-running the CLI's login on the host — so it belongs in .env with
    the API keys, never in a database row a settings request can write.
    """
    from app.config import SECRET_SETTINGS

    assert "claude_code_oauth_token" in SECRET_SETTINGS
    assert "claude_code_oauth_token" not in EDITABLE_SETTINGS
    with pytest.raises(SettingError):
        update_settings(db, {"claude_code_oauth_token": "sk-ant-oat01-leaked"}, None)

    # codex_home is the opposite case and deliberately not a secret: it is a
    # filesystem path, and the credentials it points at never enter Liffy. It is
    # still not editable, because pointing the CLI at a different credential
    # store is deployment shape rather than review tuning.
    assert "codex_home" not in EDITABLE_SETTINGS
    with pytest.raises(SettingError):
        update_settings(db, {"codex_home": "/tmp/evil"}, None)

    assert db.query(Setting).count() == 0
