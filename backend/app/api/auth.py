"""GitHub OAuth endpoints (report §9).

Deliberately thin: read the request, call ``auth_service``, map ``AuthError``
to a status code, return. Anything resembling token logic in this file belongs
in the service instead.
"""

import secrets
from urllib.parse import urlencode

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.config import settings
from app.database import get_db
from app.models.user import User
from app.schemas.auth import RefreshRequest, TokenPair, UserOut
from app.services import auth_service
from app.services.auth_service import AuthError

router = APIRouter()

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
# `repo` reaches private repositories, which Liffy needs because the project's
# own repo is private. It is a broad scope and deliberately chosen.
OAUTH_SCOPE = "repo,read:user"
STATE_COOKIE = "liffy_oauth_state"
_STATE_MAX_AGE = 600  # 10 minutes is ample for a consent screen


def _issue_pair(db: Session, user: User) -> TokenPair:
    access_token, expires_in = auth_service.create_access_token(user)
    return TokenPair(
        access_token=access_token,
        refresh_token=auth_service.issue_refresh_token(db, user),
        expires_in=expires_in,
    )


@router.get("/github", response_class=RedirectResponse, status_code=302)
def github_login() -> RedirectResponse:
    """Send the browser to GitHub's consent screen."""
    state = secrets.token_urlsafe(16)
    query = urlencode(
        {
            "client_id": settings.github_client_id,
            "redirect_uri": settings.github_redirect_uri,
            "scope": OAUTH_SCOPE,
            "state": state,
        }
    )
    response = RedirectResponse(f"{GITHUB_AUTHORIZE_URL}?{query}", status_code=302)
    response.set_cookie(
        STATE_COOKIE,
        state,
        max_age=_STATE_MAX_AGE,
        httponly=True,   # nothing in the browser needs to read this value
        samesite="lax",  # must survive the top-level redirect back from GitHub
        secure=not settings.debug,
    )
    return response


@router.get("/github/callback", response_model=TokenPair)
def github_callback(
    response: Response,
    code: str | None = None,
    state: str | None = None,
    liffy_oauth_state: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> TokenPair:
    """Complete the OAuth handshake and return our own token pair."""
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code or state")

    # The entire reason `state` exists. Constant-time comparison is free here
    # and keeps the value from leaking through response timing.
    if not liffy_oauth_state or not secrets.compare_digest(state, liffy_oauth_state):
        raise HTTPException(status_code=400, detail="OAuth state mismatch")

    try:
        github_token = auth_service.exchange_code_for_token(code)
        gh_user = auth_service.fetch_github_user(github_token)
    except AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    user = auth_service.upsert_user(db, gh_user, access_token=github_token)
    pair = _issue_pair(db, user)
    db.commit()

    # One handshake per state value.
    response.delete_cookie(STATE_COOKIE)
    return pair


@router.post("/refresh", response_model=TokenPair)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> TokenPair:
    """Spend a refresh token for a fresh pair.

    A revoked, expired or unknown token is a 401 — including the replay case,
    which is the whole point of rotation.
    """
    try:
        user, replacement = auth_service.rotate_refresh_token(db, payload.refresh_token)
    except AuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    access_token, expires_in = auth_service.create_access_token(user)
    db.commit()
    return TokenPair(
        access_token=access_token,
        refresh_token=replacement,
        expires_in=expires_in,
    )


@router.post("/logout", status_code=204)
def logout(payload: RefreshRequest, db: Session = Depends(get_db)) -> None:
    """Retire a refresh token. Idempotent — logging out twice is still a 204."""
    auth_service.revoke_refresh_token(db, payload.refresh_token)
    db.commit()


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    """Who the caller is. The frontend uses this to rehydrate a session."""
    return user
