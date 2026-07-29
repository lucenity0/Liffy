"""Shared FastAPI dependencies.

``get_current_user`` is the single place a bearer token becomes a ``User``.
AUTH-4 applies it to the repos and reviews routers; it lives here rather than
in ``api/auth.py`` so those routers do not import the auth endpoints.
"""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth_service import AuthError, decode_access_token

# auto_error=False so a missing or non-Bearer header arrives here as ``None``
# and gets the same 401 as a bad token, rather than FastAPI raising a 403
# before this function runs. Declaring the scheme also gives OpenAPI (and the
# Authorize button in /docs) an honest description of how to authenticate.
_bearer = HTTPBearer(auto_error=False, description="JWT access token from /auth/github/callback")

_UNAUTHENTICATED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the caller from the ``Authorization: Bearer <jwt>`` header.

    Every failure — absent header, wrong scheme, bad signature, expired token,
    or a token whose subject no longer exists — is the same 401. Saying which
    one it was would tell an attacker which half of the guess to keep.
    """
    if credentials is None or not credentials.credentials:
        raise _UNAUTHENTICATED

    try:
        user_id = decode_access_token(credentials.credentials)
    except AuthError:
        raise _UNAUTHENTICATED from None

    user = db.get(User, user_id)
    if user is None:
        # Signature-valid token for a deleted account.
        raise _UNAUTHENTICATED
    return user
