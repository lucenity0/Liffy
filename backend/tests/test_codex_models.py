"""Codex model discovery — the list Liffy cannot hardcode.

Every payload here is the real shape returned by
``chatgpt.com/backend-api/codex/models``, captured from a signed-in account:
six entries, ordered by ``priority``, one of them hidden.

Nothing in this file reaches the network. The point of the service is that it
degrades to an empty tuple on *every* failure, so most of these tests are about
what happens when things go wrong.
"""

import json

import pytest

from app.llm import codex_models
from app.llm.codex_models import discover_codex_models, reset_cache

# Captured verbatim, including the out-of-order priorities and the hidden
# internal model — both are what make the parsing non-trivial.
LIVE_PAYLOAD = {
    "models": [
        {"slug": "gpt-5.4", "visibility": "list", "priority": 16},
        {"slug": "gpt-5.6-luna", "visibility": "list", "priority": 3},
        {"slug": "codex-auto-review", "visibility": "hide", "priority": 43},
        {"slug": "gpt-5.6-terra", "visibility": "list", "priority": 2},
        {"slug": "gpt-5.5", "visibility": "list", "priority": 7},
        {"slug": "gpt-5.4-mini", "visibility": "list", "priority": 23},
    ]
}


class _Response:
    def __init__(self, payload, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


@pytest.fixture(autouse=True)
def _clean_cache():
    reset_cache()
    yield
    reset_cache()


@pytest.fixture()
def codex_home(tmp_path):
    """A credential directory shaped like the CLI's own."""
    (tmp_path / "auth.json").write_text(
        json.dumps({"auth_mode": "chatgpt", "tokens": {"access_token": "tok-123"}})
    )
    return str(tmp_path)


def _fake_get(monkeypatch, response, calls: list | None = None):
    def get(url, **kwargs):
        if calls is not None:
            calls.append((url, kwargs))
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(codex_models.httpx, "get", get)


def test_returns_visible_models_in_account_order(monkeypatch, codex_home) -> None:
    """Ordered by the account's own priority, not by JSON order.

    The first entry is what the dropdown shows selected, so it has to be the
    model the account would actually default to.
    """
    _fake_get(monkeypatch, _Response(LIVE_PAYLOAD))

    assert discover_codex_models(codex_home) == (
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
    )


def test_hidden_models_are_dropped(monkeypatch, codex_home) -> None:
    """`codex-auto-review` is internal; offering it produces a confusing failure."""
    _fake_get(monkeypatch, _Response(LIVE_PAYLOAD))

    assert "codex-auto-review" not in discover_codex_models(codex_home)


def test_sends_the_stored_token(monkeypatch, codex_home) -> None:
    calls: list = []
    _fake_get(monkeypatch, _Response(LIVE_PAYLOAD), calls)

    discover_codex_models(codex_home)

    assert calls[0][1]["headers"]["Authorization"] == "Bearer tok-123"
    # A page load must not be able to hang on somebody else's service.
    assert calls[0][1]["timeout"] <= 10


def test_result_is_cached(monkeypatch, codex_home) -> None:
    """The settings page is polled; this is a network call to a third party."""
    calls: list = []
    _fake_get(monkeypatch, _Response(LIVE_PAYLOAD), calls)

    discover_codex_models(codex_home)
    discover_codex_models(codex_home)

    assert len(calls) == 1


def test_cache_does_not_leak_across_credential_directories(
    monkeypatch, tmp_path, codex_home
) -> None:
    """Two directories are two accounts with two different lists.

    Caught in a live run: a lookup against a signed-in directory, followed by
    one against a path that did not exist, returned the first directory's
    models — the cache was keyed on time alone.
    """
    _fake_get(monkeypatch, _Response(LIVE_PAYLOAD))
    other = tmp_path / "other-account"
    other.mkdir()

    assert discover_codex_models(codex_home) != ()
    assert discover_codex_models(str(other)) == ()


def test_no_credentials_returns_empty(monkeypatch, tmp_path) -> None:
    """Not an error — the field falls back to free text, as it always could."""
    _fake_get(monkeypatch, _Response(LIVE_PAYLOAD))

    assert discover_codex_models(str(tmp_path)) == ()


def test_missing_credentials_are_not_cached(monkeypatch, tmp_path, codex_home) -> None:
    """Signing in should take effect without restarting the worker."""
    _fake_get(monkeypatch, _Response(LIVE_PAYLOAD))
    empty = tmp_path / "signed-out"
    empty.mkdir()

    assert discover_codex_models(str(empty)) == ()
    # Had the miss been cached, this would still be empty.
    assert discover_codex_models(codex_home) != ()


@pytest.mark.parametrize(
    "response",
    [
        _Response(LIVE_PAYLOAD, status_code=401),
        _Response({"models": "not-a-list"}),
        _Response({}),
        _Response(ValueError("not json")),
        RuntimeError("connection reset"),
    ],
    ids=["unauthorised", "wrong-shape", "empty", "bad-json", "network-error"],
)
def test_every_failure_degrades_to_free_text(monkeypatch, codex_home, response) -> None:
    """A model picker must not be able to take the settings page down.

    Each of these is a real way this can fail — an expired token, a payload
    that changed shape, no network. All of them cost the user a dropdown and
    nothing else.
    """
    _fake_get(monkeypatch, response)

    assert discover_codex_models(codex_home) == ()


def test_malformed_auth_json_is_survivable(monkeypatch, tmp_path) -> None:
    (tmp_path / "auth.json").write_text("{ not json")
    _fake_get(monkeypatch, _Response(LIVE_PAYLOAD))

    assert discover_codex_models(str(tmp_path)) == ()
