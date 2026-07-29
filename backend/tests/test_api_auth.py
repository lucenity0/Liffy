"""Endpoint tests for the OAuth flow.

``auth_service``'s two GitHub calls are monkeypatched — this file exercises the
HTTP layer (status codes, the state cookie, error mapping), not the service,
which ``test_auth_service.py`` covers offline.
"""

from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.auth import STATE_COOKIE
from app.config import settings
from app.database import Base, get_db
from app.main import app
from app.models.user import User
from app.services import auth_service
from app.services.auth_service import AuthError, GitHubUser

client = TestClient(app)

GH_USER = GitHubUser(
    id=4242, login="octocat", email="octo@example.com", avatar_url="https://a.example/1.png"
)


@pytest.fixture()
def factory():
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # one shared in-memory DB across TestClient threads
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, autoflush=False)

    def override():
        db = sessions()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    yield sessions
    app.dependency_overrides.clear()
    client.cookies.clear()


@pytest.fixture()
def github_ok(monkeypatch: pytest.MonkeyPatch):
    """A GitHub that always completes the handshake."""
    monkeypatch.setattr(auth_service, "exchange_code_for_token", lambda code: "gho_real")
    monkeypatch.setattr(auth_service, "fetch_github_user", lambda token: GH_USER)


def _begin_login() -> str:
    """Hit /auth/github and return the state it set, leaving the cookie in place."""
    response = client.get("/auth/github", follow_redirects=False)
    return parse_qs(urlparse(response.headers["location"]).query)["state"][0]


def _login(factory) -> dict:
    """Complete a full handshake and return the token pair."""
    state = _begin_login()
    return client.get(f"/auth/github/callback?code=abc&state={state}").json()


# ── /auth/github ──────────────────────────────────────────────────────────────


def test_github_login_redirects_to_github(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "github_client_id", "cid-123")
    response = client.get("/auth/github", follow_redirects=False)

    assert response.status_code == 302
    location = response.headers["location"]
    assert location.startswith("https://github.com/login/oauth/authorize")

    query = parse_qs(urlparse(location).query)
    assert query["client_id"] == ["cid-123"]
    assert query["scope"] == ["repo,read:user"]
    assert query["redirect_uri"] == [settings.github_redirect_uri]
    assert query["state"][0]

    assert response.cookies[STATE_COOKIE] == query["state"][0]
    client.cookies.clear()


def test_state_cookie_is_httponly(monkeypatch: pytest.MonkeyPatch) -> None:
    response = client.get("/auth/github", follow_redirects=False)
    set_cookie = response.headers["set-cookie"].lower()

    assert "httponly" in set_cookie
    assert "samesite=lax" in set_cookie
    client.cookies.clear()


def test_each_login_gets_a_fresh_state() -> None:
    first = _begin_login()
    second = _begin_login()
    assert first != second
    client.cookies.clear()


# ── /auth/github/callback ─────────────────────────────────────────────────────


def test_callback_success_returns_token_pair(factory, github_ok) -> None:
    body = _login(factory)

    assert body["token_type"] == "bearer"
    assert body["expires_in"] == settings.access_token_expire_minutes * 60
    assert body["access_token"] and body["refresh_token"]


def test_callback_creates_user_row(factory, github_ok) -> None:
    _login(factory)

    with factory() as db:
        user = db.scalar(select(User).where(User.github_id == 4242))
    assert user is not None
    assert user.username == "octocat"


def test_callback_state_mismatch_rejected(factory, github_ok) -> None:
    _begin_login()  # sets a cookie we then contradict
    response = client.get("/auth/github/callback?code=abc&state=not-the-cookie")

    assert response.status_code == 400
    with factory() as db:
        assert db.scalars(select(User)).all() == []
    client.cookies.clear()


def test_callback_without_state_cookie_rejected(factory, github_ok) -> None:
    client.cookies.clear()  # as if the user never visited /auth/github
    response = client.get("/auth/github/callback?code=abc&state=anything")

    assert response.status_code == 400
    with factory() as db:
        assert db.scalars(select(User)).all() == []


def test_callback_missing_code_rejected(factory, github_ok) -> None:
    state = _begin_login()
    assert client.get(f"/auth/github/callback?state={state}").status_code == 400
    client.cookies.clear()


def test_callback_github_failure_is_400_not_500(
    factory, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(_code: str) -> str:
        raise AuthError("bad_verification_code")

    monkeypatch.setattr(auth_service, "exchange_code_for_token", boom)
    state = _begin_login()
    response = client.get(f"/auth/github/callback?code=bad&state={state}")

    assert response.status_code == 400
    client.cookies.clear()


def test_second_login_reuses_the_same_user_row(factory, github_ok) -> None:
    _login(factory)
    _login(factory)

    with factory() as db:
        assert len(db.scalars(select(User)).all()) == 1


# ── /auth/refresh ─────────────────────────────────────────────────────────────


def test_refresh_returns_new_pair(factory, github_ok) -> None:
    original = _login(factory)["refresh_token"]

    response = client.post("/auth/refresh", json={"refresh_token": original})

    assert response.status_code == 200
    assert response.json()["refresh_token"] != original


def test_refresh_with_replayed_token_returns_401(factory, github_ok) -> None:
    """Spending the same refresh token twice is what token theft looks like."""
    original = _login(factory)["refresh_token"]
    assert client.post("/auth/refresh", json={"refresh_token": original}).status_code == 200

    replay = client.post("/auth/refresh", json={"refresh_token": original})
    assert replay.status_code == 401


def test_refresh_with_garbage_token_returns_401(factory) -> None:
    response = client.post("/auth/refresh", json={"refresh_token": "not-a-real-token"})
    assert response.status_code == 401  # not a 500


def test_refresh_without_body_returns_422(factory) -> None:
    assert client.post("/auth/refresh", json={}).status_code == 422


# ── /auth/logout ──────────────────────────────────────────────────────────────


def test_logout_returns_204_and_revokes(factory, github_ok) -> None:
    refresh_token = _login(factory)["refresh_token"]

    assert client.post("/auth/logout", json={"refresh_token": refresh_token}).status_code == 204
    # The revoked token can no longer buy a new pair.
    assert (
        client.post("/auth/refresh", json={"refresh_token": refresh_token}).status_code == 401
    )


def test_logout_twice_still_204(factory, github_ok) -> None:
    refresh_token = _login(factory)["refresh_token"]

    assert client.post("/auth/logout", json={"refresh_token": refresh_token}).status_code == 204
    assert client.post("/auth/logout", json={"refresh_token": refresh_token}).status_code == 204


def test_logout_with_unknown_token_still_204(factory) -> None:
    assert client.post("/auth/logout", json={"refresh_token": "never-issued"}).status_code == 204


# ── /auth/me ──────────────────────────────────────────────────────────────────


def test_me_returns_current_user(factory, github_ok) -> None:
    access_token = _login(factory)["access_token"]

    response = client.get("/auth/me", headers={"Authorization": f"Bearer {access_token}"})

    assert response.status_code == 200
    body = response.json()
    assert body["github_id"] == 4242
    assert body["username"] == "octocat"
    # The wire shape must not grow fields the contract did not promise.
    assert set(body) == {"id", "github_id", "username", "email", "avatar_url"}


def test_me_without_token_returns_401(factory) -> None:
    assert client.get("/auth/me").status_code == 401


@pytest.mark.parametrize(
    "header",
    [
        "token abc",       # wrong scheme
        "abc",             # no scheme at all
        "Bearer ",         # scheme with no credential
        "Bearer garbage",  # not a JWT
    ],
)
def test_me_with_malformed_header_returns_401(factory, header: str) -> None:
    assert client.get("/auth/me", headers={"Authorization": header}).status_code == 401


def test_me_with_expired_token_returns_401(
    factory, github_ok, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "access_token_expire_minutes", -1)
    access_token = _login(factory)["access_token"]
    monkeypatch.setattr(settings, "access_token_expire_minutes", 15)

    response = client.get("/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert response.status_code == 401


def test_me_for_deleted_user_returns_401(factory, github_ok) -> None:
    access_token = _login(factory)["access_token"]

    with factory() as db:
        db.delete(db.scalar(select(User)))
        db.commit()

    response = client.get("/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert response.status_code == 401


def test_no_placeholder_response_values_remain() -> None:
    """#155's definition of done: no stub endpoint still returns "placeholder".

    Matches the quoted string literal, not the English word — a comment that
    happens to say "placeholder" is not a stubbed response.
    """
    import re
    from pathlib import Path

    literal = re.compile(r"""['"]placeholder['"]""", re.IGNORECASE)
    hits = [str(p) for p in Path("app").rglob("*.py") if literal.search(p.read_text())]
    assert hits == []
