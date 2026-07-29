import uuid

import pytest
from pydantic import ValidationError

from app.models.user import User
from app.schemas.auth import AuthCallbackQuery, RefreshRequest, TokenPair, UserOut


def test_token_pair_defaults_to_bearer() -> None:
    pair = TokenPair(access_token="a.b.c", refresh_token="opaque", expires_in=900)
    assert pair.token_type == "bearer"


def test_token_pair_rejects_other_token_types() -> None:
    # The frontend switches on this literal; anything else is a contract break.
    with pytest.raises(ValidationError):
        TokenPair(
            access_token="a.b.c",
            refresh_token="opaque",
            expires_in=900,
            token_type="basic",
        )


def test_user_out_reads_from_orm_object() -> None:
    # from_attributes is what lets the endpoints return a User row directly.
    user = User(
        id=uuid.uuid4(),
        github_id=42,
        username="octo",
        email=None,
        avatar_url=None,
    )
    out = UserOut.model_validate(user)
    assert out.github_id == 42
    assert out.username == "octo"
    assert out.email is None


def test_refresh_request_requires_a_token() -> None:
    assert RefreshRequest(refresh_token="opaque").refresh_token == "opaque"
    with pytest.raises(ValidationError):
        RefreshRequest()


def test_auth_callback_query_requires_code_and_state() -> None:
    query = AuthCallbackQuery(code="abc", state="xyz")
    assert (query.code, query.state) == ("abc", "xyz")
    # A callback without state cannot be CSRF-checked, so it must not parse.
    with pytest.raises(ValidationError):
        AuthCallbackQuery(code="abc")
