"""Shared FastAPI dependencies.

``get_current_user`` is the single place a bearer token becomes a ``User``.
AUTH-4 applies it to the repos and reviews routers; it lives here rather than
in ``api/auth.py`` so those routers do not import the auth endpoints.

The ownership helpers below are the second thing every authenticated route
needs: a token says *who*, and these say *whose*.
"""

import uuid

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.review_comment import ReviewComment
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


# ── Ownership ─────────────────────────────────────────────────────────────────
#
# Everything a user owns hangs off ``repositories.user_id``; nothing below it
# carries a user id of its own. So proving ownership of a review or a comment
# means walking back up to the repository, and both walks are written here once
# rather than inline at each call site — ``api/reviews.py`` and
# ``api/feedback.py`` would otherwise each grow their own copy, and a copy that
# drifts is a copy that leaks.
#
# **404, never 403.** A 403 confirms the row exists, which is itself the
# information worth hiding: it turns an id guess into an oracle for whether
# somebody else's review is real. ``api/repos.py::_get_repo_or_404`` settled
# this pattern and AUTH-4 applied it across the reviews routes; one route
# answering differently would leak by comparison with the others.


def owned_review_or_404(db: Session, review_id: uuid.UUID, user: User) -> Review:
    """Fetch one of the caller's reviews, or 404.

    One ``select`` with explicit joins rather than four ``db.get`` calls up the
    chain: the walk is `reviews -> pull_requests -> repositories.user_id`, and
    doing it a row at a time costs three round trips to answer a question the
    database can answer in one.
    """
    review = db.scalar(
        select(Review)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(Review.id == review_id, Repository.user_id == user.id)
    )
    if review is None:
        raise HTTPException(status_code=404, detail="Review not found")
    return review


def owned_comment_or_404(db: Session, comment_id: uuid.UUID, user: User) -> ReviewComment:
    """Fetch one of the caller's review comments, or 404.

    The same walk as above with one more join on the front:
    `review_comments -> reviews -> pull_requests -> repositories.user_id`.
    """
    comment = db.scalar(
        select(ReviewComment)
        .join(Review, ReviewComment.review_id == Review.id)
        .join(PullRequest, Review.pr_id == PullRequest.id)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(ReviewComment.id == comment_id, Repository.user_id == user.id)
    )
    if comment is None:
        raise HTTPException(status_code=404, detail="Comment not found")
    return comment
