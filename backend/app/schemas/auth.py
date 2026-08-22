"""Auth wire schemas (report §9).

Deliberately dumb: types and nothing else. Every rule about what makes a token
valid lives in ``app.services.auth_service``, so these stay usable as the
frozen contract the frontend builds against.
"""

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int  # access-token lifetime, in seconds


class RefreshRequest(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    github_id: int
    username: str
    email: str | None
    avatar_url: str | None
    # Published so the UI can hide what it cannot use — the settings page 403s
    # for everyone else. Not a security boundary: the gate is `require_owner`
    # in `api/deps.py`, and this is only what stops the nav offering a door
    # that does not open.
    is_owner: bool


class AuthCallbackQuery(BaseModel):
    code: str
    state: str
