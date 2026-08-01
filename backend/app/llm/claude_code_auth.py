"""Checking a Claude Code subscription token before Liffy claims it works.

The settings page reports this credential as "Configured". That word has to
mean something — a badge that turns green for a typo is the same failure as
the one it replaced, just further along.

The check is deliberately weak in one direction and strong in the other. A
token Anthropic explicitly rejects is refused at connect time, where the person
who pasted it is still watching. Anything else — no network, an unexpected
status, a changed response shape — is accepted, because a settings page that
cannot save a *valid* token because it could not reach the internet is worse
than one that accepts a bad one and fails at review time with an error that
already names the cause.
"""

from __future__ import annotations

import httpx

# OAuth tokens authenticate as a bearer token with the OAuth beta header —
# not as `x-api-key`, which is the API-key path and rejects these outright.
_VERIFY_URL = "https://api.anthropic.com/v1/models?limit=1"
_OAUTH_BETA = "oauth-2025-04-20"
_TIMEOUT = 8.0


class TokenRejected(ValueError):
    """Anthropic said this token is not valid. The only refusable outcome."""


def looks_like_a_token(value: str) -> bool:
    """Cheap shape check, kept loose on purpose.

    Deliberately *not* a prefix match. Anthropic owns that format and can
    change it, and a client-side rule that rejects a token the CLI just minted
    would be an outage with no way around it from the UI. This catches the
    realistic paste mistakes — nothing, whitespace, a truncated fragment — and
    leaves the verdict to Anthropic.
    """
    stripped = value.strip()
    return bool(stripped) and len(stripped) >= 20 and not any(c.isspace() for c in stripped)


def verify_token(token: str) -> None:
    """Raise ``TokenRejected`` if Anthropic rejects it; return otherwise.

    Returning is not proof the token is good — see the module docstring. It
    means "nothing said otherwise", which is the strongest claim available
    without spending review quota.
    """
    if not looks_like_a_token(token):
        raise TokenRejected(
            "That does not look like a token. Paste the whole value that "
            "`claude setup-token` printed, with no surrounding quotes."
        )

    try:
        response = httpx.get(
            _VERIFY_URL,
            headers={
                "Authorization": f"Bearer {token.strip()}",
                "anthropic-beta": _OAUTH_BETA,
                "anthropic-version": "2023-06-01",
            },
            timeout=_TIMEOUT,
        )
    except Exception:
        # Could not ask. Not grounds to refuse the user's own credential.
        return

    if response.status_code in (401, 403):
        raise TokenRejected(
            "Anthropic rejected that token. Run `claude setup-token` again and "
            "paste the new value — tokens can be revoked or expire."
        )
