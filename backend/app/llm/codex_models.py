"""Which Codex models this account can actually use.

Liffy cannot hardcode a list. Codex slugs are specific to the CLI version *and*
the plan — this machine's config names `gpt-5.6-luna`, while the once-obvious
`gpt-5-codex` fails a run outright with "Model metadata not found". A guessed
dropdown would be wrong for most people, and a free-text box asks them to type
a string nobody can be expected to know.

So the list is fetched from the account, using the credentials the CLI already
stored. Nothing new is asked of the user: the same `auth.json` that authorises
a review authorises this.

Two properties this must hold, because it runs behind a page load:

- **It never raises.** Every failure — no credentials, no network, an endpoint
  that changed shape — returns an empty tuple, and the settings page falls back
  to the free-text field it would have shown anyway. A model picker is a
  convenience; it must not be able to take the settings page down with it.
- **It is cached.** The settings page is polled, and this is a network call to
  somebody else's service. One lookup per process per hour is plenty for a list
  that changes when OpenAI ships a model.
"""

from __future__ import annotations

import json
import os
import time

import httpx

# The endpoint the Codex CLI itself reads its model list from. Unofficial, and
# treated as such: pinned behind a short timeout, parsed defensively, and
# allowed to fail without consequence.
_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
_TIMEOUT = 5.0
_CACHE_TTL = 3600.0

# Keyed by credential directory, not just by time. Two directories are two
# different accounts with two different model lists, and a cache that ignored
# which one was asked about would answer for the wrong one.
_cache: dict[str, tuple[float, tuple[str, ...]]] = {}


def _access_token(codex_home: str) -> str | None:
    """The ChatGPT access token the CLI stored, or None if there isn't one."""
    home = codex_home or os.path.join(os.path.expanduser("~"), ".codex")
    try:
        with open(os.path.join(home, "auth.json"), encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    tokens = payload.get("tokens")
    if not isinstance(tokens, dict):
        return None
    token = tokens.get("access_token")
    return token if isinstance(token, str) and token else None


def _parse(payload: object) -> tuple[str, ...]:
    """Slugs in the order the account would show them, hidden ones dropped.

    ``priority`` is the CLI's own ordering, so the first entry is the model the
    account would default to rather than whatever the JSON happened to list
    first. Entries marked hidden are internal — `codex-auto-review` is one —
    and picking them would produce a confusing failure at review time.
    """
    if not isinstance(payload, dict):
        return ()
    entries = payload.get("models")
    if not isinstance(entries, list):
        return ()

    ranked: list[tuple[int, str]] = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        slug = item.get("slug")
        if not isinstance(slug, str) or not slug.strip():
            continue
        visibility = item.get("visibility")
        if isinstance(visibility, str) and visibility.strip().lower() in {"hide", "hidden"}:
            continue
        priority = item.get("priority")
        rank = int(priority) if isinstance(priority, (int, float)) else 10_000
        ranked.append((rank, slug.strip()))

    ranked.sort()
    seen: set[str] = set()
    ordered: list[str] = []
    for _, slug in ranked:
        if slug not in seen:
            seen.add(slug)
            ordered.append(slug)
    return tuple(ordered)


def discover_codex_models(codex_home: str = "", *, now: float | None = None) -> tuple[str, ...]:
    """Model slugs available to the signed-in Codex account, or ``()``.

    ``()`` means "no list to offer", never "no models exist" — the caller shows
    a free-text field, which is what it would have shown regardless.
    """
    stamp = time.monotonic() if now is None else now
    cached = _cache.get(codex_home)
    if cached is not None and stamp - cached[0] < _CACHE_TTL:
        return cached[1]

    token = _access_token(codex_home)
    if token is None:
        # Not an error worth caching: signing in should take effect without a
        # restart, and the check is a cheap file read.
        return ()

    try:
        response = httpx.get(
            _MODELS_URL,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "Origin": "https://chatgpt.com",
            },
            timeout=_TIMEOUT,
        )
        models = _parse(response.json()) if response.status_code == 200 else ()
    except Exception:
        # Deliberately broad. Anything that goes wrong here — DNS, TLS, a
        # changed payload, a rate limit — costs the user a dropdown, and must
        # not cost them the settings page.
        models = ()

    _cache[codex_home] = (stamp, models)
    return models


def reset_cache() -> None:
    """Drop the cached lists. For tests, and for a future manual refresh."""
    _cache.clear()
