import pytest
from conftest import auth_headers, seed_user
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.config import SECRET_SETTINGS, apply_overrides, settings
from app.database import Base, get_db
from app.llm import claude_code_auth
from app.main import app
from app.models.setting import Setting
from app.services.settings_service import refresh_overrides

client = TestClient(app)


def _unreachable(*args, **kwargs):
    """Anthropic not reachable — the verifier's documented accept-anyway path."""
    raise RuntimeError("no network in tests")


class _Rejecting:
    """Anthropic answering "no". The one outcome that refuses a connect."""

    def __init__(self, status_code: int) -> None:
        self.status_code = status_code

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
        "key", "label", "requirement", "applies_to",
        "connectable", "connect_command", "is_set", "source",
    }


def test_a_secret_says_whether_the_page_or_the_dotfile_set_it(
    seeded, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`is_set` cannot answer "can I disconnect this?", so it must not be asked.

    A token in `backend/.env` and one connected from the page both read as set.
    The page showed Disconnect for both, and on a `.env` value the request
    deleted a row that was not there and returned an identical document — a
    button that looked broken while doing exactly what it was told. The `.env`
    token could not be replaced from the page either, because Connect only
    appeared when nothing was set at all.
    """
    key = "claude_code_oauth_token"
    monkeypatch.setattr(claude_code_auth.httpx, "get", _unreachable)

    monkeypatch.setattr(settings, key, "")
    by_key = {s["key"]: s for s in client.get("/settings", headers=seeded["headers"]).json()["secrets"]}
    assert (by_key[key]["is_set"], by_key[key]["source"]) == (False, "default")

    # Set in the environment, not stored here: reportable, not disconnectable.
    monkeypatch.setattr(settings, key, "sk-ant-oat01-from-dotenv")
    by_key = {s["key"]: s for s in client.get("/settings", headers=seeded["headers"]).json()["secrets"]}
    assert (by_key[key]["is_set"], by_key[key]["source"]) == (True, "env")

    # Connected from the page: the one state Disconnect can act on.
    _connect(seeded, key, "sk-ant-oat01-" + "c" * 40)
    by_key = {s["key"]: s for s in client.get("/settings", headers=seeded["headers"]).json()["secrets"]}
    assert (by_key[key]["is_set"], by_key[key]["source"]) == (True, "override")

    client.delete(f"/settings/secrets/{key}", headers=seeded["headers"])
    by_key = {s["key"]: s for s in client.get("/settings", headers=seeded["headers"]).json()["secrets"]}
    # Back to the dotfile's, which is what disconnect promises — and the page
    # must now say so instead of offering to disconnect it again.
    assert (by_key[key]["is_set"], by_key[key]["source"]) == (True, "env")


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
    assert "codex_effort" in editable
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


def test_codex_effort_is_provider_scoped_and_explicit(seeded) -> None:
    body = client.get("/settings", headers=seeded["headers"]).json()
    effort = next(s for s in body["editable"] if s["key"] == "codex_effort")

    assert effort["applies_to"] == ["codex"]
    assert effort["choices"] == ["low", "medium", "high", "xhigh"]
    assert effort["value"] == "medium"


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


# ── Connecting a credential from the page ─────────────────────────────────────
#
# The settings page exists so nobody has to find the right line in a dotfile.
# That was false for the one credential the page itself invites you to need:
# selecting `claude_code` told you to go and edit .env.

def _connect(seeded, key: str, value: str):
    return client.post(
        f"/settings/secrets/{key}",
        json={"value": value},
        headers=seeded["headers"],
    )


def test_connecting_stores_the_token_and_reports_it_configured(
    seeded, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "claude_code_oauth_token", "")
    # Anthropic is not reachable from the test suite; the verifier's documented
    # behaviour is to accept when it cannot ask.
    monkeypatch.setattr(claude_code_auth.httpx, "get", _unreachable)

    response = _connect(seeded, "claude_code_oauth_token", "sk-ant-oat01-" + "x" * 40)

    assert response.status_code == 200
    by_key = {s["key"]: s for s in response.json()["secrets"]}
    assert by_key["claude_code_oauth_token"]["is_set"] is True
    # Still never the value — connecting does not turn a secret into a setting.
    assert "value" not in by_key["claude_code_oauth_token"]
    assert "sk-ant-oat01" not in response.text


def test_a_connected_token_reaches_the_worker(seeded, monkeypatch) -> None:
    """A row nothing reads is the same as no row.

    `load_overrides` drops keys that are not editable, and secrets are not
    editable — so without an explicit carve-out the token would store, report
    "Configured", and never be applied to a review.
    """
    monkeypatch.setattr(settings, "claude_code_oauth_token", "")
    monkeypatch.setattr(claude_code_auth.httpx, "get", _unreachable)
    token = "sk-ant-oat01-" + "y" * 40

    _connect(seeded, "claude_code_oauth_token", token)

    # What the worker does at the start of every review.
    with seeded["factory"]() as db:
        refresh_overrides(db)
    assert settings.claude_code_oauth_token == token


def test_anthropic_rejecting_the_token_is_a_422(seeded, monkeypatch) -> None:
    """A green badge for a dead token is the failure this check exists to stop."""
    monkeypatch.setattr(settings, "claude_code_oauth_token", "")
    monkeypatch.setattr(
        claude_code_auth.httpx, "get", lambda *a, **k: _Rejecting(401)
    )

    response = _connect(seeded, "claude_code_oauth_token", "sk-ant-oat01-" + "z" * 40)

    assert response.status_code == 422
    assert "rejected" in response.json()["detail"].lower()


def test_an_unreachable_check_does_not_block_connecting(seeded, monkeypatch) -> None:
    """Being offline must not stop someone saving their own valid credential."""
    monkeypatch.setattr(settings, "claude_code_oauth_token", "")
    monkeypatch.setattr(claude_code_auth.httpx, "get", _unreachable)

    assert _connect(seeded, "claude_code_oauth_token", "sk-ant-oat01-" + "q" * 40).status_code == 200


def test_obvious_paste_mistakes_are_caught_without_a_round_trip(
    seeded, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "claude_code_oauth_token", "")

    for bad in ("", "   ", "short", "has a space in it aaaaaaaaaaaaaaaaaaaaaa"):
        response = _connect(seeded, "claude_code_oauth_token", bad)
        assert response.status_code == 422, bad


def test_only_connectable_secrets_can_be_written(seeded, monkeypatch) -> None:
    """The endpoint is a door, not a corridor.

    `PATCH /settings` refuses every secret and keeps refusing them; this route
    accepts exactly the ones marked connectable. A settings page able to write
    `jwt_secret_key` would be a way to forge sessions.
    """
    monkeypatch.setattr(claude_code_auth.httpx, "get", _unreachable)

    for key in ("jwt_secret_key", "github_token", "anthropic_api_key"):
        response = _connect(seeded, key, "x" * 50)
        assert response.status_code == 422, key
        # Refused, not quietly stored: the canary is still what it was.
        assert getattr(settings, key) == SECRET_CANARIES[key]


def test_disconnecting_falls_back_to_env(seeded, monkeypatch) -> None:
    """Disconnect removes Liffy's copy; `.env` is what it falls back *to*.

    Both halves are pinned here because the first version of this test asserted
    only the empty case and then failed on a machine whose `.env` genuinely had
    the token set — the test was reading the developer's dotfile through the
    mounted source tree and calling correct behaviour a bug.
    """
    monkeypatch.setattr(claude_code_auth.httpx, "get", _unreachable)

    # Nothing in .env: disconnecting leaves it unset.
    monkeypatch.setattr(settings, "claude_code_oauth_token", "")
    _connect(seeded, "claude_code_oauth_token", "sk-ant-oat01-" + "w" * 40)
    response = client.delete(
        "/settings/secrets/claude_code_oauth_token", headers=seeded["headers"]
    )
    assert response.status_code == 200
    by_key = {s["key"]: s for s in response.json()["secrets"]}
    assert by_key["claude_code_oauth_token"]["is_set"] is False

    # A value in .env: disconnecting reveals it again rather than blanking it.
    monkeypatch.setattr(settings, "claude_code_oauth_token", "from-dotenv")
    _connect(seeded, "claude_code_oauth_token", "sk-ant-oat01-" + "e" * 40)
    response = client.delete(
        "/settings/secrets/claude_code_oauth_token", headers=seeded["headers"]
    )
    by_key = {s["key"]: s for s in response.json()["secrets"]}
    assert by_key["claude_code_oauth_token"]["is_set"] is True
    assert settings.claude_code_oauth_token == "from-dotenv"


def test_connecting_requires_authentication() -> None:
    assert client.post(
        "/settings/secrets/claude_code_oauth_token", json={"value": "x" * 50}
    ).status_code in (401, 403)
    assert client.delete(
        "/settings/secrets/claude_code_oauth_token"
    ).status_code in (401, 403)
