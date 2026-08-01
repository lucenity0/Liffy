from dataclasses import dataclass
from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings

# Development default so a fresh clone runs without setup. It is a constant in a
# public repo, so anything signed with it is forgeable by anyone who can read
# this file — auth_service refuses to mint tokens with it outside debug mode.
# 48 bytes clears the 32-byte RFC 7518 minimum for HS256.
DEV_JWT_SECRET = "dev-only-insecure-secret-change-me-before-deploy"

class Settings(BaseSettings):
    # Database
    database_url: str = Field(default="postgresql://localhost/liffy")
    
    # Redis
    redis_url: str = Field(default="redis://localhost:6379/0")
    
    # GitHub OAuth
    github_client_id: str = Field(default="")
    github_client_secret: str = Field(default="")
    github_webhook_secret: str = Field(default="change-me")
    # Must byte-match the callback URL registered on the GitHub OAuth App —
    # scheme, host, port and path, with no trailing slash. A mismatch fails at
    # GitHub's end with an unhelpful error rather than anywhere in this code.
    github_redirect_uri: str = Field(default="http://localhost:8000/auth/github/callback")
    # Where /auth/github/callback hands the browser back to. The OAuth round
    # trip is a top-level navigation, so the callback cannot answer with JSON —
    # it has to redirect somewhere the SPA is actually mounted.
    frontend_url: str = Field(default="http://localhost:5173")
    # Server-side PAT used until per-user OAuth lands (token seam in github_service).
    github_token: str = Field(default="")
    
    # JWT
    jwt_secret_key: str = Field(default=DEV_JWT_SECRET)
    jwt_algorithm: str = Field(default="HS256")
    access_token_expire_minutes: int = Field(default=15)
    refresh_token_expire_days: int = Field(default=30)

    @field_validator("jwt_secret_key")
    @classmethod
    def _blank_means_unset(cls, value: str) -> str:
        """Treat an empty JWT_SECRET_KEY as absent.

        ``docker-compose.yml`` passes ``JWT_SECRET_KEY: ${JWT_SECRET_KEY:-}``,
        which sets the variable to an empty string when the host has not
        exported one. That would otherwise override this field's default and
        break token minting with a confusing key-length error, so an empty
        value falls back to the development default — which is still refused
        outright when DEBUG=False.
        """
        return value or DEV_JWT_SECRET
    
    # ── Review LLM ────────────────────────────────────────────────────────────
    # "anthropic" uses the official SDK; "openai" speaks the OpenAI wire format
    # and therefore also covers anything that emulates it — Gemini's compat
    # endpoint, or a local Ollama at http://localhost:11434/v1 (no key, no cost).
    llm_provider: str = Field(default="anthropic")
    anthropic_api_key: str = Field(default="")
    openai_api_key: str = Field(default="")
    openai_base_url: str = Field(default="")
    # Per-provider, deliberately: the two namespaces share no model names, so a
    # single LLM_MODEL would silently send e.g. "gemini-2.5-flash" to Anthropic
    # after a provider switch and fail as an unhelpful 404 with a valid key.
    anthropic_model: str = Field(default="claude-opus-5")
    openai_model: str = Field(default="gpt-4o")
    # Constrain generation to the review schema rather than just "valid JSON".
    # Needed for small local models, which otherwise return well-formed
    # documents of their own invention (see #178). Opt-in because support
    # varies across OpenAI-compatible endpoints: Ollama and OpenAI implement
    # it, and one that does not will reject the request rather than degrade.
    openai_use_json_schema: bool = Field(default=False)
    # Thinking is on by default on this model family and bills as output tokens,
    # so effort — not max_tokens, which is only a ceiling — is the real cost
    # lever. "medium" is a deliberate cost choice for review specifically: the
    # model stays accurate at lower effort on bug-finding, and the first live
    # run at the "high" default cost ~$0.35 for one PR. Raise to "high" or
    # "xhigh" if reviews start missing things; the levels are low | medium |
    # high | xhigh | max.
    anthropic_effort: str = Field(default="medium")
    # llm_provider="claude_code" drives the locally-installed Claude Code CLI,
    # which authenticates with the user's own subscription — the only provider
    # that needs no API key. Local deployment only: the credentials live in the
    # user's home directory, not in the container.
    claude_code_binary: str = Field(default="claude")
    claude_code_model: str = Field(default="claude-opus-5")
    # Generous: a review is a long single call, and reviews are already async.
    claude_code_timeout: float = Field(default=600.0)
    # Caps thinking *and* response text together on Claude models, where
    # thinking is on by default — too tight and the review truncates mid-JSON,
    # which reads like a parser bug rather than a budget problem.
    llm_max_tokens: int = Field(default=16000)

    # ── Embeddings ────────────────────────────────────────────────────────────
    # Local by default: no key, no quota, no billing in the retrieval path, so
    # CI and demos cannot be broken by someone else's account state.
    embedding_provider: str = Field(default="local")
    embedding_model: str = Field(default="text-embedding-3-small")  # openai only
    local_embedding_model: str = Field(default="BAAI/bge-small-en-v1.5")  # 384-dim

    # ChromaDB — HTTP server when chroma_host is set (compose); local persistent dir otherwise
    chroma_host: str = Field(default="")
    chroma_port: int = Field(default=8000)
    chroma_persist_dir: str = Field(default="./chroma")
    
    # ── Posting reviews back to GitHub (GH-2) ────────────────────────────────
    # **Default off, deliberately.** Writing to somebody's pull request is not
    # a behaviour a merge should silently switch on, and the test suite must
    # never be one env var away from posting to a real PR.
    post_reviews_to_github: bool = Field(default=False)
    # "native"       — approve/request_changes are sent as GitHub review events
    # "comment_only" — every review is posted as a COMMENT
    #
    # `comment_only` by default: `request_changes` on somebody else's PR
    # genuinely blocks their merge, and an AI tool that blocks a human's merge
    # by default is the kind of default people uninstall over. Opting in is the
    # right shape. (On your *own* PR the choice is moot — GitHub 422s an
    # APPROVE or REQUEST_CHANGES either way, and `resolve_event` downgrades.)
    github_review_event_mode: str = Field(default="comment_only")

    # App
    debug: bool = Field(default=True)

    # CORS — comma-separated, NOT list[str]: pydantic-settings parses list fields
    # from env as JSON, so "http://a,http://b" would raise at import time.
    # 5174 is where Vite lands when 5173 is already taken (a second checkout).
    cors_origins: str = Field(
        default="http://localhost:5173,http://localhost:5174"
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def __getattribute__(self, name: str) -> Any:
        """Consult the runtime override store before the field's own value.

        This is what makes SETTINGS-1's "change it in the app" real. The store
        is keyed only by the eight names in ``EDITABLE_SETTINGS``, and the
        membership test is against a module-level frozenset rather than
        anything on ``self`` — so this adds one hash lookup per attribute read
        and cannot recurse.

        ``is not None`` rather than a truth test, because ``False`` is a
        legitimate override for the two booleans and would otherwise fall
        through to the env value on every read.
        """
        if name in _OVERRIDABLE:
            override = _overrides.get(name)
            if override is not None:
                return override
        return super().__getattribute__(name)


# ── Runtime-editable settings (SETTINGS-1) ────────────────────────────────────
#
# The classification agreed on issue #236. The rule that decided it:
#
#   **A setting is editable only if it is read inside a function.**
#
# Anything read at module import can never observe a runtime override without
# a restart, so exposing it as an editable control would be a lie told by an
# authoritative-looking page — worse than not offering the page at all. Every
# key below was checked against its call site; every one is read lazily.
#
# Two settings sit in `READ_ONLY_SETTINGS` despite being read lazily, which is
# a judgement call rather than a mechanical one — see the note there.


class SettingError(ValueError):
    """A rejected write. The message is shown to the user, so it says what
    would have been acceptable rather than only that something was wrong."""


@dataclass(frozen=True)
class SettingSpec:
    """How one editable setting is described, parsed and validated.

    ``parse`` is the only path from stored text to a live value, so a row
    hand-written into the table goes through exactly the same validation as a
    ``PATCH`` — which is what stops a direct INSERT being a way around the API.
    """

    group: str
    label: str
    help: str
    kind: str  # "str" | "bool" | "int" | "choice"
    choices: tuple[str, ...] = ()
    minimum: int | None = None
    maximum: int | None = None

    def parse(self, raw: str) -> Any:
        if self.kind == "bool":
            lowered = raw.strip().lower()
            if lowered in {"true", "1", "yes", "on"}:
                return True
            if lowered in {"false", "0", "no", "off"}:
                return False
            raise SettingError(f"Expected true or false, got {raw!r}.")

        if self.kind == "int":
            try:
                parsed = int(raw.strip())
            except ValueError:
                raise SettingError(f"Expected a whole number, got {raw!r}.") from None
            if self.minimum is not None and parsed < self.minimum:
                raise SettingError(f"Must be at least {self.minimum}.")
            if self.maximum is not None and parsed > self.maximum:
                raise SettingError(f"Must be at most {self.maximum}.")
            return parsed

        if self.kind == "choice":
            if raw not in self.choices:
                raise SettingError(f"Must be one of: {', '.join(self.choices)}.")
            return raw

        text = raw.strip()
        if not text:
            raise SettingError("Cannot be empty.")
        return text

    def serialize(self, value: Any) -> str:
        """Inverse of ``parse``, for storing. Bools go to the spelling
        ``parse`` prefers, so a round trip through the table is stable."""
        if self.kind == "bool":
            return "true" if value else "false"
        return str(value)


EDITABLE_SETTINGS: dict[str, SettingSpec] = {
    "llm_provider": SettingSpec(
        group="review_model",
        label="Provider",
        help=(
            "Which transport runs the review. `openai` also covers anything "
            "speaking the OpenAI wire format — Gemini's compat endpoint, or a "
            "local Ollama. `claude_code` uses the CLI and your own "
            "subscription, and only works when Liffy runs outside a container."
        ),
        kind="choice",
        choices=("anthropic", "openai", "claude_code"),
    ),
    "anthropic_model": SettingSpec(
        group="review_model",
        label="Anthropic model",
        help="Used when the provider is `anthropic`.",
        kind="str",
    ),
    "openai_model": SettingSpec(
        group="review_model",
        label="OpenAI model",
        help=(
            "Used when the provider is `openai`. Per-provider deliberately: "
            "the two namespaces share no model names, so one combined field "
            "would send a Gemini name to Anthropic after a switch and fail as "
            "an unhelpful 404."
        ),
        kind="str",
    ),
    "anthropic_effort": SettingSpec(
        group="review_model",
        label="Thinking effort",
        help=(
            "The real cost lever on Claude models, where thinking is on by "
            "default and bills as output tokens. `medium` is a deliberate "
            "choice for review; raise it if reviews start missing things."
        ),
        kind="choice",
        choices=("low", "medium", "high", "xhigh", "max"),
    ),
    "llm_max_tokens": SettingSpec(
        group="review_model",
        label="Max tokens",
        help=(
            "Caps thinking and response text together. Too tight and the "
            "review truncates mid-JSON, which reads as a parser bug rather "
            "than a budget problem — hence the floor."
        ),
        kind="int",
        minimum=4000,
        maximum=200000,
    ),
    "openai_use_json_schema": SettingSpec(
        group="review_model",
        label="Constrain output to the review schema",
        help=(
            "Needed for small local models, which otherwise return "
            "well-formed documents of their own invention. Opt-in because "
            "support varies: an endpoint without it rejects the request "
            "rather than degrading."
        ),
        kind="bool",
    ),
    "post_reviews_to_github": SettingSpec(
        group="github_posting",
        label="Post reviews to GitHub",
        help=(
            "Off by default, deliberately. Turning this on means Liffy writes "
            "comments to real pull requests."
        ),
        kind="bool",
    ),
    "github_review_event_mode": SettingSpec(
        group="github_posting",
        label="Review event mode",
        help=(
            "`comment_only` posts every review as a comment. `native` sends "
            "approve and request_changes as real GitHub review events — and "
            "`request_changes` blocks a human's merge."
        ),
        kind="choice",
        choices=("comment_only", "native"),
    ),
}

# Confirmed in the UI before they can be enabled, because both reach outside
# Liffy: one writes to somebody's pull request, the other can block their merge.
CONFIRM_ON_ENABLE: frozenset[str] = frozenset(
    {"post_reviews_to_github", "github_review_event_mode"}
)


@dataclass(frozen=True)
class ReadOnlySetting:
    """Shown, explained, and not editable. The reason is the point: it answers
    "where is this configured?" without inviting a change that cannot work."""

    group: str
    label: str
    reason: str


# Read at import, or consumed by docker-compose rather than by Python — a
# runtime override could not take effect, so offering one would be dishonest.
READ_ONLY_SETTINGS: dict[str, ReadOnlySetting] = {
    "database_url": ReadOnlySetting(
        "infrastructure", "Database URL",
        "The engine is built at import (database.py). Changing it needs a restart.",
    ),
    "redis_url": ReadOnlySetting(
        "infrastructure", "Redis URL",
        "Celery reads this when the worker process starts.",
    ),
    "cors_origins": ReadOnlySetting(
        "infrastructure", "CORS origins",
        "Applied to the middleware stack at import (main.py).",
    ),
    # ── The judgement call ───────────────────────────────────────────────────
    # These six are read lazily, so the machinery *could* override them. They
    # are read-only anyway: changing an embedding model or a Chroma host does
    # not reconfigure retrieval, it orphans every vector already indexed and
    # silently degrades every future review, with no error anywhere. A control
    # that quietly invalidates the index is exactly the trap this issue exists
    # to remove.
    "embedding_provider": ReadOnlySetting(
        "infrastructure", "Embedding provider",
        "Changing this orphans every embedding already indexed. Re-index after "
        "editing it in backend/.env.",
    ),
    "embedding_model": ReadOnlySetting(
        "infrastructure", "Embedding model",
        "Changing this orphans every embedding already indexed.",
    ),
    "local_embedding_model": ReadOnlySetting(
        "infrastructure", "Local embedding model",
        "Changing this orphans every embedding already indexed.",
    ),
    "chroma_host": ReadOnlySetting(
        "infrastructure", "Chroma host",
        "Points at the vector store holding your index. A new host is an empty index.",
    ),
    "chroma_port": ReadOnlySetting("infrastructure", "Chroma port", "Set alongside the host."),
    "chroma_persist_dir": ReadOnlySetting(
        "infrastructure", "Chroma directory",
        "Local store path, used when no Chroma host is set.",
    ),
    "github_redirect_uri": ReadOnlySetting(
        "authentication", "OAuth redirect URI",
        "Must byte-match the callback registered on the GitHub OAuth App. It "
        "cannot be corrected from inside Liffy.",
    ),
    "frontend_url": ReadOnlySetting(
        "authentication", "Frontend URL",
        "Where the OAuth callback hands the browser back to.",
    ),
    "jwt_algorithm": ReadOnlySetting(
        "authentication", "JWT algorithm", "Changing it invalidates every issued token.",
    ),
    "access_token_expire_minutes": ReadOnlySetting(
        "authentication", "Access token lifetime (min)", "Read when a token is minted.",
    ),
    "refresh_token_expire_days": ReadOnlySetting(
        "authentication", "Refresh token lifetime (days)", "Read when a token is minted.",
    ),
    "debug": ReadOnlySetting(
        "infrastructure", "Debug mode",
        "Controls cookie security and the refusal to sign with the development "
        "JWT secret. Not a runtime toggle.",
    ),
    "openai_base_url": ReadOnlySetting(
        "review_model", "OpenAI base URL",
        "Deployment shape rather than review tuning — set it in backend/.env.",
    ),
    "claude_code_binary": ReadOnlySetting(
        "review_model", "Claude Code binary", "Path to the CLI on the host.",
    ),
    "claude_code_model": ReadOnlySetting(
        "review_model", "Claude Code model", "Used when the provider is `claude_code`.",
    ),
    "claude_code_timeout": ReadOnlySetting(
        "review_model", "Claude Code timeout (s)", "Set it in backend/.env.",
    ),
}

# Never sent to the frontend — not the value, not a masked value, not a length.
# The API answers `is_set: true|false` and nothing else.
SECRET_SETTINGS: tuple[str, ...] = (
    "jwt_secret_key",
    "github_client_secret",
    "github_webhook_secret",
    "github_token",
    "anthropic_api_key",
    "openai_api_key",
)

_OVERRIDABLE: frozenset[str] = frozenset(EDITABLE_SETTINGS)

# The live override store, read by ``Settings.__getattribute__``.
#
# Process-local by design. The API is a single uvicorn process (the Dockerfile
# CMD carries no --workers), so invalidating here on write is complete rather
# than partial; the worker is a separate process and refreshes this at the
# start of each review task instead. See ``services.settings_service``.
_overrides: dict[str, Any] = {}


def apply_overrides(values: dict[str, Any]) -> None:
    """Replace the override store wholesale.

    Wholesale rather than merged: a setting reset to its default is expressed
    by its row being *deleted*, and a merge would leave the old value behind
    forever.
    """
    _overrides.clear()
    _overrides.update(values)


def active_overrides() -> dict[str, Any]:
    """A copy, so a caller cannot mutate the store by holding onto it."""
    return dict(_overrides)


settings = Settings()
