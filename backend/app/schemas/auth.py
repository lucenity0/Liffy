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


class AuthCallbackQuery(BaseModel):
    code: str
    state: str
