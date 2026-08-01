import pytest
from conftest import auth_headers, seed_user
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.config import SECRET_SETTINGS, apply_overrides, settings
from app.database import Base, get_db
from app.main import app
from app.models.setting import Setting

client = TestClient(app)

# Distinctive enough that finding one in a response body cannot be a
# coincidence, and long enough not to appear as a substring by accident.
SECRET_CANARIES = {
    # 48 bytes, clearing the 32-byte HS256 minimum — this one really is used
    # to sign the fixture's token, so a short value would work but warn.
    "jwt_secret_key": "canary-jwt-3f9a2b7c1d-padding-to-clear-hs256-min",
    "github_client_secret": "canary-ghsecret-8e1d4a",
    "github_webhook_secret": "canary-webhook-77b2c9",
    "github_token": "canary-ghtoken-51ade0",
    "anthropic_api_key": "canary-anthropic-9cd3f1",
    "openai_api_key": "canary-openai-2b6e8a",
}


@pytest.fixture()
def seeded(monkeypatch):
    engine = create_engine(
        "sqlite://", future=True, connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)

    # Every secret carries a findable value, so "no secret leaked" is a claim
    # about the response rather than about the fixture happening to be empty.
    #
    # Before the token is minted, not after: `jwt_secret_key` is one of the
    # canaries, and a token signed with the old secret fails verification
    # against the new one — which shows up as a wall of 401s rather than as
    # anything resembling its cause.
    for key, value in SECRET_CANARIES.items():
        monkeypatch.setattr(settings, key, value)

    with factory() as db:
        user = seed_user(db, github_id=1, username="octo")
        db.commit()
        headers = auth_headers(user)
        user_id = user.id

    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override

    yield {"headers": headers, "user": user_id, "factory": factory}

    app.dependency_overrides.clear()
    # The override store is process-global. A setting written here would
    # otherwise reconfigure every test that runs after this one.
    apply_overrides({})


# ── Authentication ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("method", ["get", "patch"])
def test_settings_require_auth(seeded, method) -> None:
    response = client.request(method.upper(), "/settings", json={"values": {}})
    assert response.status_code == 401


# ── The leak test ─────────────────────────────────────────────────────────────


def test_secrets_never_appear_in_response(seeded) -> None:
    """Asserted against the **whole serialized body**, not field by field.

    A per-field assertion only checks the fields somebody remembered to check.
    This is the test that still fails if a future change serializes the
    settings object wholesale, adds a debug echo, or puts a value in an error
    message — none of which a field-by-field version would notice.
    """
    raw = client.get("/settings", headers=seeded["headers"]).text

    for key, canary in SECRET_CANARIES.items():
        assert canary not in raw, f"{key} leaked into the settings response"


def test_secrets_are_reported_as_set_or_not(seeded, monkeypatch) -> None:
    monkeypatch.setattr(settings, "openai_api_key", "")

    body = client.get("/settings", headers=seeded["headers"]).json()
    by_key = {s["key"]: s for s in body["secrets"]}

    assert set(by_key) == set(SECRET_SETTINGS)
    assert by_key["anthropic_api_key"]["is_set"] is True
    assert by_key["openai_api_key"]["is_set"] is False
    # `is_set` plus description is the entire contract — no value, under any
    # name. `requirement` and `applies_to` describe what an unset key *means*;
    # neither is derived from the secret itself.
    assert set(by_key["anthropic_api_key"]) == {
        "key", "label", "requirement", "applies_to", "is_set",
    }


def test_an_unset_secret_says_whether_it_is_actually_needed(seeded) -> None:
    """"Not configured" is the right answer for a key nobody needs.

    `claude_code_oauth_token` is empty on every host install and that is
    correct — the CLI reads the user's own login. Reporting it in the same
    words as a missing Anthropic key sent people hunting a problem they did
    not have.
    """
    body = client.get("/settings", headers=seeded["headers"]).json()
    by_key = {s["key"]: s for s in body["secrets"]}

    token = by_key["claude_code_oauth_token"]
    assert token["applies_to"] == ["claude_code"]
    assert "Only needed in Docker" in token["requirement"]

    # ...where a key the selected provider depends on says so plainly.
    assert by_key["anthropic_api_key"]["applies_to"] == ["anthropic"]
    assert "Required" in by_key["anthropic_api_key"]["requirement"]

    # Liffy's own secrets belong to no provider and are always relevant.
    assert by_key["jwt_secret_key"]["applies_to"] == []


# ── Reading ───────────────────────────────────────────────────────────────────


def test_get_reports_the_three_buckets(seeded) -> None:
    body = client.get("/settings", headers=seeded["headers"]).json()

    editable = {s["key"] for s in body["editable"]}
    read_only = {s["key"] for s in body["read_only"]}

    assert "anthropic_effort" in editable
    assert "post_reviews_to_github" in editable
    # The classification's whole point: these are visible but not editable.
    assert "database_url" in read_only
    assert "database_url" not in editable
    assert "chroma_host" in read_only
    # And no secret appears in either of the two buckets that carry values.
    assert not (editable | read_only) & set(SECRET_SETTINGS)


def test_read_only_settings_explain_themselves(seeded) -> None:
    """A disabled field without a reason is just a broken field."""
    body = client.get("/settings", headers=seeded["headers"]).json()

    for entry in body["read_only"]:
        assert entry["reason"].strip(), f"{entry['key']} is disabled with no reason"


def test_source_distinguishes_default_from_changed_here(seeded) -> None:
    before = client.get("/settings", headers=seeded["headers"]).json()
    effort = next(s for s in before["editable"] if s["key"] == "anthropic_effort")
    assert effort["source"] == "default"
    assert effort["value"] == "medium"

    client.patch(
        "/settings", json={"values": {"anthropic_effort": "high"}},
        headers=seeded["headers"],
    )

    after = client.get("/settings", headers=seeded["headers"]).json()
    effort = next(s for s in after["editable"] if s["key"] == "anthropic_effort")
    assert effort["source"] == "override"
    assert effort["value"] == "high"
    # Still reports what it would be without the override, so the UI can say
    # what "changed here" was changed *from*.
    assert effort["default_value"] == "medium"


def test_dangerous_settings_are_flagged_for_confirmation(seeded) -> None:
    body = client.get("/settings", headers=seeded["headers"]).json()
    flagged = {s["key"] for s in body["editable"] if s["confirm_on_enable"]}

    # Each of these reaches outside Liffy: two write to somebody's pull
    # request, and `openai_base_url` decides who receives the code being
    # reviewed — a control that silently redirected the diff to another
    # company's endpoint would be the worst thing on this page.
    assert flagged == {
        "post_reviews_to_github",
        "github_review_event_mode",
        "openai_base_url",
    }


# ── Writing ───────────────────────────────────────────────────────────────────


def test_patch_persists_and_reads_back(seeded) -> None:
    response = client.patch(
        "/settings",
        json={"values": {"anthropic_effort": "xhigh", "llm_max_tokens": "20000"}},
        headers=seeded["headers"],
    )
    assert response.status_code == 200

    body = client.get("/settings", headers=seeded["headers"]).json()
    values = {s["key"]: s["value"] for s in body["editable"]}

    assert values["anthropic_effort"] == "xhigh"
    # Typed back as an int, not the string it was stored as.
    assert values["llm_max_tokens"] == 20000


def test_cache_invalidated_on_write(seeded) -> None:
    """Read, write, read again — in one test, because the bug this guards
    against is precisely that the second read serves the first one's answer."""
    assert settings.anthropic_effort == "medium"

    client.patch(
        "/settings", json={"values": {"anthropic_effort": "low"}},
        headers=seeded["headers"],
    )

    # No TTL to wait out: the next read of the ordinary attribute is correct.
    assert settings.anthropic_effort == "low"


def test_non_allowlisted_key_rejected(seeded) -> None:
    response = client.patch(
        "/settings",
        json={"values": {"database_url": "postgresql://evil/db"}},
        headers=seeded["headers"],
    )

    assert response.status_code == 422
    assert settings.database_url != "postgresql://evil/db"
    with seeded["factory"]() as db:
        assert db.query(Setting).count() == 0


def test_secret_cannot_be_written_through_patch(seeded) -> None:
    """Secrets are not merely hidden from reads — they are not writable here.

    A settings page that could *set* an API key would be a credential entry
    form on an endpoint any logged-in user can reach.
    """
    response = client.patch(
        "/settings",
        json={"values": {"anthropic_api_key": "sk-attacker"}},
        headers=seeded["headers"],
    )

    assert response.status_code == 422
    assert settings.anthropic_api_key == SECRET_CANARIES["anthropic_api_key"]


def test_unknown_key_rejected_rather_than_stored_silently(seeded) -> None:
    response = client.patch(
        "/settings", json={"values": {"not_a_setting": "1"}},
        headers=seeded["headers"],
    )

    assert response.status_code == 422
    with seeded["factory"]() as db:
        assert db.query(Setting).count() == 0


def test_invalid_effort_rejected(seeded) -> None:
    response = client.patch(
        "/settings", json={"values": {"anthropic_effort": "ludicrous"}},
        headers=seeded["headers"],
    )

    assert response.status_code == 422
    # The message names what would have been acceptable, so the frontend can
    # put something useful on the field.
    assert "medium" in response.json()["detail"]
    assert settings.anthropic_effort == "medium"


def test_max_tokens_floor_rejected(seeded) -> None:
    response = client.patch(
        "/settings", json={"values": {"llm_max_tokens": "500"}},
        headers=seeded["headers"],
    )

    assert response.status_code == 422
    assert "4000" in response.json()["detail"]


# ── Read-only values are not automatically safe to publish ────────────────────


def test_database_password_is_not_published_in_the_read_only_bucket(
    seeded, monkeypatch
) -> None:
    """The read-only bucket carries values, and one of them holds a password.

    `SECRET_SETTINGS` keeps API keys out of the response, but `database_url`
    is classified read-only — correctly, since knowing *where* the database is
    answers the question the page exists to answer. Its password does not, and
    compose ships `postgresql://liffy:liffy@postgres:5432/liffy`, so shipping
    the value verbatim hands the database credentials to every authenticated
    user through the bucket next to the one guarding against exactly that.

    The host survives; only the password is masked.
    """
    monkeypatch.setattr(
        settings, "database_url", "postgresql://liffy:sup3rs3cret@postgres:5432/liffy"
    )
    monkeypatch.setattr(settings, "redis_url", "redis://:redispw@redis:6379/0")

    raw = client.get("/settings", headers=seeded["headers"]).text

    assert "sup3rs3cret" not in raw
    assert "redispw" not in raw
    # Still useful: the server it points at is intact.
    assert "postgres:5432" in raw


def test_credential_free_urls_are_left_alone(seeded, monkeypatch) -> None:
    """Masking must not fire on the common case, or every local developer's
    settings page starts reporting a password that is not there."""
    monkeypatch.setattr(settings, "database_url", "postgresql://localhost/liffy")

    body = client.get("/settings", headers=seeded["headers"]).json()
    by_key = {s["key"]: s["value"] for s in body["read_only"]}

    assert by_key["database_url"] == "postgresql://localhost/liffy"
