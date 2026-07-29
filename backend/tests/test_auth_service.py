"""Offline tests for the auth service.

Nothing here touches the network or needs a key: the two GitHub calls take an
injected ``httpx.Client`` backed by ``MockTransport``, exactly as
``test_github_service.py`` does for ``GitHubClient``.
"""

import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import jwt
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

import app.models  # noqa: F401  -- register all tables on Base.metadata
from app.config import DEV_JWT_SECRET, settings
from app.database import Base
from app.models.refresh_token import RefreshToken
from app.models.user import User
from app.services import auth_service
from app.services.auth_service import AuthError, GitHubUser


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


@pytest.fixture()
def user(db: Session) -> User:
    user = User(github_id=1, username="octo")
    db.add(user)
    db.flush()
    return user


def _mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# ── JWT ───────────────────────────────────────────────────────────────────────


def test_access_token_roundtrip(user: User) -> None:
    token, expires_in = auth_service.create_access_token(user)
    assert auth_service.decode_access_token(token) == user.id
    assert expires_in == settings.access_token_expire_minutes * 60


def test_expired_access_token_rejected(user: User, monkeypatch: pytest.MonkeyPatch) -> None:
    # A negative lifetime issues a token that was already expired when minted,
    # which avoids sleeping or freezing the clock.
    monkeypatch.setattr(settings, "access_token_expire_minutes", -1)
    token, _ = auth_service.create_access_token(user)

    with pytest.raises(AuthError):
        auth_service.decode_access_token(token)


def test_tampered_access_token_rejected(user: User) -> None:
    token, _ = auth_service.create_access_token(user)
    header, payload, signature = token.split(".")
    # Flip a character in the payload; the signature no longer matches.
    mangled = payload[:-1] + ("A" if payload[-1] != "A" else "B")

    with pytest.raises(AuthError):
        auth_service.decode_access_token(f"{header}.{mangled}.{signature}")


def test_token_signed_with_other_secret_rejected(user: User) -> None:
    forged = jwt.encode(
        {
            "sub": str(user.id),
            "iat": datetime.now(timezone.utc),
            "exp": datetime.now(timezone.utc) + timedelta(minutes=15),
        },
        # Same length class as a real key, so this proves the *signature* is
        # what gets rejected rather than a key-strength complaint.
        "an-entirely-different-but-equally-long-secret",
        algorithm=settings.jwt_algorithm,
    )

    with pytest.raises(AuthError):
        auth_service.decode_access_token(forged)


def test_garbage_access_token_rejected() -> None:
    with pytest.raises(AuthError):
        auth_service.decode_access_token("not-a-jwt-at-all")


def test_access_token_without_subject_rejected() -> None:
    # Signature-valid but semantically useless; must not resolve to a user.
    token = jwt.encode(
        {"exp": datetime.now(timezone.utc) + timedelta(minutes=15)},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )

    with pytest.raises(AuthError):
        auth_service.decode_access_token(token)


def test_short_signing_key_refuses_to_mint(user: User, monkeypatch: pytest.MonkeyPatch) -> None:
    # RFC 7518 §3.2 wants >= 32 bytes for HS256; a shorter key weakens every
    # token signed with it, so minting must fail rather than warn.
    monkeypatch.setattr(settings, "jwt_secret_key", "too-short")

    with pytest.raises(AuthError, match="at least 32 bytes"):
        auth_service.create_access_token(user)


def test_default_secret_refused_outside_debug(user: User, monkeypatch: pytest.MonkeyPatch) -> None:
    # The development default is a public constant in this repository. Signing
    # real tokens with it would let any reader of the source forge a session.
    monkeypatch.setattr(settings, "jwt_secret_key", DEV_JWT_SECRET)
    monkeypatch.setattr(settings, "debug", False)

    with pytest.raises(AuthError, match="development default"):
        auth_service.create_access_token(user)


def test_blank_secret_env_falls_back_to_dev_default() -> None:
    # docker-compose passes JWT_SECRET_KEY: ${JWT_SECRET_KEY:-}, which sets the
    # variable to "" when the host exports nothing. Without the fallback that
    # empty value would override the field default and break every login.
    from app.config import Settings

    assert Settings(jwt_secret_key="").jwt_secret_key == DEV_JWT_SECRET


def test_default_secret_allowed_in_debug(user: User, monkeypatch: pytest.MonkeyPatch) -> None:
    # A fresh clone must still run without any setup.
    monkeypatch.setattr(settings, "jwt_secret_key", DEV_JWT_SECRET)
    monkeypatch.setattr(settings, "debug", True)

    token, _ = auth_service.create_access_token(user)
    assert auth_service.decode_access_token(token) == user.id


# ── Refresh token lifecycle ───────────────────────────────────────────────────


def test_issue_refresh_token_stores_only_hash(db: Session, user: User) -> None:
    raw = auth_service.issue_refresh_token(db, user)

    row = db.scalar(select(RefreshToken))
    assert row is not None
    assert row.token_hash == hashlib.sha256(raw.encode()).hexdigest()
    # The raw value must not appear anywhere in the stored row.
    assert raw not in {row.token_hash, str(row.id)}
    assert row.expires_at is not None
    assert row.revoked_at is None


def test_rotate_returns_new_token_and_revokes_old(db: Session, user: User) -> None:
    original = auth_service.issue_refresh_token(db, user)

    rotated_user, replacement = auth_service.rotate_refresh_token(db, original)

    assert rotated_user.id == user.id
    assert replacement != original

    old = db.scalar(
        select(RefreshToken).where(
            RefreshToken.token_hash == hashlib.sha256(original.encode()).hexdigest()
        )
    )
    new = db.scalar(
        select(RefreshToken).where(
            RefreshToken.token_hash == hashlib.sha256(replacement.encode()).hexdigest()
        )
    )
    assert old is not None and old.revoked_at is not None
    assert new is not None and new.revoked_at is None


def test_rotating_revoked_token_rejected(db: Session, user: User) -> None:
    """The single most important test in the milestone.

    Rotating twice with the same raw token is what a stolen-token replay looks
    like. The second attempt must fail, or theft is undetectable.
    """
    original = auth_service.issue_refresh_token(db, user)
    auth_service.rotate_refresh_token(db, original)

    with pytest.raises(AuthError):
        auth_service.rotate_refresh_token(db, original)


def test_rotating_expired_token_rejected(db: Session, user: User) -> None:
    raw = auth_service.issue_refresh_token(db, user)
    row = db.scalar(select(RefreshToken))
    assert row is not None
    row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.flush()

    with pytest.raises(AuthError):
        auth_service.rotate_refresh_token(db, raw)


def test_rotating_unknown_token_rejected(db: Session, user: User) -> None:
    with pytest.raises(AuthError):
        auth_service.rotate_refresh_token(db, "never-issued")


def test_revoke_is_idempotent(db: Session, user: User) -> None:
    raw = auth_service.issue_refresh_token(db, user)

    auth_service.revoke_refresh_token(db, raw)
    auth_service.revoke_refresh_token(db, raw)  # logging out twice is not an error
    auth_service.revoke_refresh_token(db, "never-issued")

    row = db.scalar(select(RefreshToken))
    assert row is not None and row.revoked_at is not None


def test_revoked_token_cannot_be_rotated(db: Session, user: User) -> None:
    raw = auth_service.issue_refresh_token(db, user)
    auth_service.revoke_refresh_token(db, raw)

    with pytest.raises(AuthError):
        auth_service.rotate_refresh_token(db, raw)


# ── GitHub OAuth exchange ─────────────────────────────────────────────────────


def test_exchange_code_success() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Accept"] == "application/json"
        return httpx.Response(200, json={"access_token": "gho_real", "token_type": "bearer"})

    with _mock_client(handler) as client:
        assert auth_service.exchange_code_for_token("code123", client=client) == "gho_real"


def test_exchange_code_error_body_raises() -> None:
    """GitHub answers a bad code with HTTP 200 and an error in the body.

    Checking only the status code would accept this as a success.
    """

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"error": "bad_verification_code", "error_description": "The code is incorrect."},
        )

    with _mock_client(handler) as client:
        with pytest.raises(AuthError):
            auth_service.exchange_code_for_token("bad", client=client)


def test_exchange_code_missing_token_raises() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"token_type": "bearer"})

    with _mock_client(handler) as client:
        with pytest.raises(AuthError):
            auth_service.exchange_code_for_token("code123", client=client)


def test_exchange_code_http_error_raises() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream down")

    with _mock_client(handler) as client:
        with pytest.raises(AuthError):
            auth_service.exchange_code_for_token("code123", client=client)


def test_fetch_github_user() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer gho_real"
        return httpx.Response(
            200,
            json={
                "id": 4242,
                "login": "octocat",
                "email": "octo@example.com",
                "avatar_url": "https://avatars.example/octo.png",
            },
        )

    with _mock_client(handler) as client:
        gh_user = auth_service.fetch_github_user("gho_real", client=client)

    assert gh_user == GitHubUser(
        id=4242,
        login="octocat",
        email="octo@example.com",
        avatar_url="https://avatars.example/octo.png",
    )


def test_fetch_github_user_tolerates_null_email() -> None:
    # GitHub omits email when the user keeps it private.
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": 1, "login": "octocat"})

    with _mock_client(handler) as client:
        gh_user = auth_service.fetch_github_user("gho_real", client=client)

    assert gh_user.email is None
    assert gh_user.avatar_url is None


def test_fetch_github_user_http_error_raises() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "Bad credentials"})

    with _mock_client(handler) as client:
        with pytest.raises(AuthError):
            auth_service.fetch_github_user("revoked", client=client)


# ── upsert_user ───────────────────────────────────────────────────────────────


GH_USER = GitHubUser(
    id=4242, login="octocat", email="octo@example.com", avatar_url="https://a.example/1.png"
)


def test_upsert_user_creates_row(db: Session) -> None:
    created = auth_service.upsert_user(db, GH_USER)

    assert isinstance(created.id, uuid.UUID)
    assert created.github_id == 4242
    assert created.username == "octocat"


def test_upsert_user_is_idempotent(db: Session) -> None:
    first = auth_service.upsert_user(db, GH_USER)
    renamed = GitHubUser(
        id=4242, login="octocat-renamed", email="new@example.com", avatar_url="https://a/2.png"
    )
    second = auth_service.upsert_user(db, renamed)

    assert first.id == second.id
    assert len(db.scalars(select(User)).all()) == 1
    # Profile fields refresh on re-login.
    assert second.username == "octocat-renamed"
    assert second.email == "new@example.com"
    assert second.avatar_url == "https://a/2.png"


def test_upsert_user_distinguishes_github_ids(db: Session) -> None:
    auth_service.upsert_user(db, GH_USER)
    other = GitHubUser(id=9999, login="hubot", email=None, avatar_url=None)
    auth_service.upsert_user(db, other)

    assert len(db.scalars(select(User)).all()) == 2


def test_upsert_user_stores_github_token(db: Session) -> None:
    user = auth_service.upsert_user(db, GH_USER, access_token="gho_first")
    assert user.github_access_token == "gho_first"


def test_upsert_user_refreshes_token_on_relogin(db: Session) -> None:
    auth_service.upsert_user(db, GH_USER, access_token="gho_stale")
    user = auth_service.upsert_user(db, GH_USER, access_token="gho_fresh")

    assert user.github_access_token == "gho_fresh"
    assert len(db.scalars(select(User)).all()) == 1


def test_upsert_user_without_token_keeps_existing(db: Session) -> None:
    # Callers that only refresh the profile must not blank out the token.
    auth_service.upsert_user(db, GH_USER, access_token="gho_keep")
    user = auth_service.upsert_user(db, GH_USER)

    assert user.github_access_token == "gho_keep"


def test_user_out_does_not_expose_github_token() -> None:
    """The OAuth token must never reach the wire through /auth/me."""
    from app.schemas.auth import UserOut

    assert "github_access_token" not in UserOut.model_fields
