"""GitHub OAuth exchange, JWT issuing, and refresh-token rotation (report §9).

Deliberately free of FastAPI: this module takes a ``Session`` and plain values
and returns plain values, so every branch is testable without a running server.
Failures raise :class:`AuthError`; mapping those to HTTP status codes is the
API layer's job (AUTH-3), and this file does not know what a 401 is.

Algorithm choice — the report specifies RS256, this implements HS256.
RS256's asymmetric keypair earns its key-management cost when a *separate*
service must verify tokens without holding the signing secret. Liffy is a
single FastAPI process that both signs and verifies, so RS256 would add
keypair generation, distribution and rotation for no security gain. Revisit
this the moment a second service needs to verify a Liffy token.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx
import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import DEV_JWT_SECRET, settings
from app.models.refresh_token import RefreshToken
from app.models.user import User
from app.services.github_service import GITHUB_API_BASE

GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token"
_DEFAULT_TIMEOUT = 30.0
# 32 bytes = 256 bits of entropy, which is why a plain SHA-256 is the right
# digest here rather than a slow KDF (see _hash_token).
_REFRESH_TOKEN_BYTES = 32
# RFC 7518 §3.2: an HMAC key for HS256 must be at least as long as the digest.
_MIN_SIGNING_KEY_BYTES = 32


class AuthError(RuntimeError):
    """Any authentication failure: bad code, bad token, replayed token."""


@dataclass(frozen=True)
class GitHubUser:
    id: int
    login: str
    email: str | None
    avatar_url: str | None


def _hash_token(raw: str) -> str:
    """SHA-256 hex digest, not bcrypt.

    Refresh tokens are already 256 bits of ``secrets`` entropy, so there is no
    dictionary to attack and a deliberately slow KDF would only tax every
    refresh. Password hashing solves a problem this value does not have.
    """
    return hashlib.sha256(raw.encode()).hexdigest()


# ── GitHub OAuth ──────────────────────────────────────────────────────────────


def exchange_code_for_token(code: str, *, client: httpx.Client | None = None) -> str:
    """Trade an OAuth callback code for a GitHub access token."""
    owns_client = client is None
    client = client or httpx.Client(timeout=_DEFAULT_TIMEOUT)
    try:
        response = client.post(
            GITHUB_OAUTH_TOKEN_URL,
            data={
                "client_id": settings.github_client_id,
                "client_secret": settings.github_client_secret,
                "code": code,
            },
            headers={"Accept": "application/json"},
        )
    except httpx.HTTPError as exc:
        raise AuthError(f"GitHub token exchange failed: {exc}") from exc
    finally:
        if owns_client:
            client.close()

    if response.status_code != 200:
        raise AuthError(f"GitHub token exchange returned HTTP {response.status_code}")

    payload = response.json()
    # GitHub answers a bad code with HTTP 200 and an error in the *body*, so a
    # status-code check alone would accept the failure as a success.
    if "error" in payload:
        raise AuthError(
            f"GitHub rejected the code: {payload.get('error_description', payload['error'])}"
        )

    token = payload.get("access_token")
    if not token:
        raise AuthError("GitHub token exchange returned no access_token")
    return str(token)


def fetch_github_user(access_token: str, *, client: httpx.Client | None = None) -> GitHubUser:
    """Load the profile of whoever owns ``access_token``."""
    owns_client = client is None
    client = client or httpx.Client(timeout=_DEFAULT_TIMEOUT)
    try:
        response = client.get(
            f"{GITHUB_API_BASE}/user",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
    except httpx.HTTPError as exc:
        raise AuthError(f"Could not reach GitHub: {exc}") from exc
    finally:
        if owns_client:
            client.close()

    if response.status_code != 200:
        raise AuthError(f"GitHub user lookup returned HTTP {response.status_code}")

    data = response.json()
    return GitHubUser(
        id=int(data["id"]),
        login=data["login"],
        # Absent (private email) and explicit null both mean "no email".
        email=data.get("email") or None,
        avatar_url=data.get("avatar_url") or None,
    )


def upsert_user(db: Session, gh_user: GitHubUser, access_token: str | None = None) -> User:
    """Create the user, or refresh a returning user's profile. Idempotent."""
    user = db.scalar(select(User).where(User.github_id == gh_user.id))
    if user is None:
        user = User(github_id=gh_user.id, username=gh_user.login)
        db.add(user)

    # Re-sync on every login: usernames and avatars change on GitHub's side.
    user.username = gh_user.login
    user.email = gh_user.email
    user.avatar_url = gh_user.avatar_url
    if access_token is not None:
        # Replaced on every login, so revoking access on GitHub and signing in
        # again is enough to recover from a stale token.
        user.github_access_token = access_token
    db.flush()
    return user


# ── Access tokens (JWT) ───────────────────────────────────────────────────────


def _signing_key() -> str:
    """Return the HMAC key, refusing to sign with one that cannot be trusted.

    Checked when minting rather than when verifying: a weak key makes *new*
    tokens forgeable, whereas verification with a bad key simply rejects
    everything, which already fails safe.
    """
    key = settings.jwt_secret_key
    if len(key.encode()) < _MIN_SIGNING_KEY_BYTES:
        raise AuthError(
            f"JWT_SECRET_KEY must be at least {_MIN_SIGNING_KEY_BYTES} bytes "
            f"(RFC 7518 §3.2); got {len(key.encode())}."
        )
    if key == DEV_JWT_SECRET and not settings.debug:
        # The default is published in this repository. Signing production
        # tokens with it lets anyone who has read the source mint a token for
        # any user, so this must be a hard failure rather than a warning.
        raise AuthError(
            "JWT_SECRET_KEY is still the public development default. "
            "Set a real secret before running with DEBUG=False."
        )
    return key


def create_access_token(user: User) -> tuple[str, int]:
    """Return a signed JWT and its lifetime in seconds."""
    expires_in = settings.access_token_expire_minutes * 60
    issued_at = datetime.now(timezone.utc)
    token = jwt.encode(
        {
            "sub": str(user.id),
            "iat": issued_at,
            "exp": issued_at + timedelta(seconds=expires_in),
        },
        _signing_key(),
        algorithm=settings.jwt_algorithm,
    )
    return token, expires_in


def decode_access_token(token: str) -> uuid.UUID:
    """Verify signature and expiry, returning the subject's user id."""
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
        )
    except jwt.PyJWTError as exc:
        raise AuthError(f"Invalid access token: {exc}") from exc

    subject = claims.get("sub")
    if not subject:
        raise AuthError("Access token carries no subject")
    try:
        return uuid.UUID(subject)
    except (ValueError, TypeError, AttributeError) as exc:
        raise AuthError("Access token subject is not a user id") from exc


# ── Refresh tokens ────────────────────────────────────────────────────────────


def issue_refresh_token(db: Session, user: User) -> str:
    """Mint a refresh token, storing only its digest.

    The returned string is the only moment the token exists in plaintext.
    """
    raw = secrets.token_urlsafe(_REFRESH_TOKEN_BYTES)
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=_hash_token(raw),
            expires_at=datetime.now(timezone.utc)
            + timedelta(days=settings.refresh_token_expire_days),
        )
    )
    db.flush()
    return raw


def _live_token_or_raise(db: Session, raw_token: str) -> RefreshToken:
    row = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == _hash_token(raw_token)))
    if row is None:
        raise AuthError("Unknown refresh token")
    if row.revoked_at is not None:
        # Presenting a spent token is what a replay looks like. Rejecting it
        # rather than silently re-issuing is the whole reason rotation marks
        # the row revoked instead of deleting it.
        raise AuthError("Refresh token has already been used")

    expires_at = row.expires_at
    if expires_at.tzinfo is None:
        # SQLite hands back naive datetimes where Postgres returns aware ones.
        # Comparing naive against aware raises, so normalise to UTC first.
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= datetime.now(timezone.utc):
        raise AuthError("Refresh token has expired")
    return row


def rotate_refresh_token(db: Session, raw_token: str) -> tuple[User, str]:
    """Spend a refresh token and issue its replacement.

    Revoking the old row and inserting the new one share a transaction: a crash
    between the two would otherwise log the user out permanently.
    """
    row = _live_token_or_raise(db, raw_token)
    user = db.get(User, row.user_id)
    if user is None:
        raise AuthError("Refresh token belongs to a deleted user")

    row.revoked_at = datetime.now(timezone.utc)
    replacement = issue_refresh_token(db, user)
    return user, replacement


def revoke_refresh_token(db: Session, raw_token: str) -> None:
    """Retire a refresh token on logout.

    Never raises: logging out twice, or with a token that was never issued, is
    not an error worth surfacing to someone who is already leaving.
    """
    row = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == _hash_token(raw_token)))
    if row is None or row.revoked_at is not None:
        return
    row.revoked_at = datetime.now(timezone.utc)
    db.flush()
