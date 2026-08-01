from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

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
    # and "codex" the Codex CLI. Both authenticate with the user's own
    # subscription — the only providers that need no API key.
    #
    # Outside a container they read the credentials in the user's home
    # directory and need nothing here. *Inside* one there is no home directory
    # to read, so the token below is required; see the OAuth token fields.
    claude_code_binary: str = Field(default="claude")
    claude_code_model: str = Field(default="claude-opus-5")
    # Generous: a review is a long single call, and reviews are already async.
    claude_code_timeout: float = Field(default=600.0)
    codex_binary: str = Field(default="codex")
    # Empty on purpose, unlike every other model field. Codex model slugs are
    # specific to the CLI version *and* the account — this machine's config
    # names `gpt-5.6-luna`, while an older pin like `gpt-5-codex` fails the run
    # outright with "Model metadata not found". Empty means "whatever
    # ~/.codex/config.toml already says", which is both more likely to work and
    # the choice the user already made. Set it to override.
    codex_model: str = Field(default="")
    codex_timeout: float = Field(default=600.0)
    # Minted on the *host* with `claude setup-token` and handed to the container
    # as an environment variable, which is what makes claude_code work in Docker
    # at all. Deliberately a token rather than a mounted ~/.claude: a bind-mount
    # of a live credential store is fragile across platforms and gives the
    # container a credential it can rewrite. A token is a copy, and revocable.
    claude_code_oauth_token: str = Field(default="")
    # Codex gets no equivalent, because the CLI provides none. Measured against
    # codex-cli 0.146: there is no auth environment variable, and
    # `codex login --with-access-token` rejects a ChatGPT subscription token —
    # it wants an agent-identity JWT. The only thing that works is pointing
    # CODEX_HOME at a directory holding a real auth.json.
    #
    # So in a container this provider needs the credential *directory* mounted,
    # which is a weaker position than the Claude path and is why it is opt-in
    # and empty by default: unset means "host only", and the provider refuses to
    # start in a container rather than failing later. docker-compose.subscription.yml
    # has the mount, commented, with the trade-offs written out.
    codex_home: str = Field(default="")
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

    # Runtime overrides are the *third* source, not the only one. This still
    # has to load `backend/.env` — it is where every key, secret and connection
    # string actually lives, and none of them is runtime-editable. Dropping it
    # silently empties `anthropic_api_key` and friends on any non-compose run,
    # which reads as "my keys stopped working" rather than as a config change.
    #
    # `extra="ignore"` because a .env file is read whole: it carries keys this
    # class does not declare (compose reads some of them too), and the
    # pydantic-settings default of `forbid` turns each one into a boot failure.
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    def __getattribute__(self, name: str) -> Any:
        """Consult the runtime override store before the field's own value.

        This is what makes SETTINGS-1's "change it in the app" real. The store
        is keyed by ``EDITABLE_SETTINGS`` plus ``CONNECTABLE_SECRETS``, and the
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
    # Known-good values offered as a dropdown, *without* closing the field.
    # Deliberately not `choices`: `openai` also drives Ollama, Gemini's compat
    # endpoint, and anything else speaking that wire format, so a closed list
    # would lock out the providers the field exists to support. The UI offers
    # these and keeps a "custom" escape hatch; validation is unchanged.
    suggestions: tuple[str, ...] = ()
    # Which `llm_provider` values this setting is relevant to. Empty means
    # always. The settings page shows four model fields today and three of them
    # do nothing for whichever provider you picked — this is what lets the page
    # show one.
    applies_to: tuple[str, ...] = ()
    # Empty is a real value for some settings, not a mistake. `codex_model`
    # empty means "whatever ~/.codex/config.toml already says", which is the
    # right default given Codex slugs are version- and account-specific.
    allow_empty: bool = False
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
        if not text and not self.allow_empty:
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
            "local Ollama. `claude_code` and `codex` drive those CLIs against "
            "a subscription you already pay for, so they need no API key. In "
            "Docker they additionally need an OAuth token in backend/.env and "
            "the subscription compose overlay; see the README. Both are for "
            "local, personal use."
        ),
        kind="choice",
        choices=("anthropic", "openai", "claude_code", "codex"),
    ),
    # One model field per provider, shown one at a time.
    #
    # The keys stay separate on purpose — a single combined `review_model`
    # would carry a Gemini name into Anthropic after a provider switch and fail
    # as an unhelpful 404, and switching back would have lost the old value.
    # `applies_to` gives the page the single control without giving up that
    # property: the storage is per-provider, only the *display* is unified.
    "anthropic_model": SettingSpec(
        group="review_model",
        label="Model",
        help="Runs the review through Anthropic's API, billed per token.",
        kind="str",
        applies_to=("anthropic",),
        # Ordered by what a reviewer should reach for first, not by price.
        # Availability is per-account: a model your key cannot reach fails at
        # review time, which is why this is a suggestion list and not `choices`.
        suggestions=(
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-haiku-4-5",
            "claude-fable-5",
            "claude-opus-4-8",
        ),
    ),
    "claude_code_model": SettingSpec(
        group="review_model",
        label="Model",
        help=(
            "Runs the review through the Claude Code CLI on your subscription. "
            "The CLI also accepts the bare aliases `opus`, `sonnet`, `haiku` "
            "and `fable`; which models you can actually reach depends on your "
            "plan."
        ),
        kind="str",
        applies_to=("claude_code",),
        suggestions=(
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-haiku-4-5",
            "claude-fable-5",
        ),
    ),
    "codex_model": SettingSpec(
        group="review_model",
        label="Model",
        help=(
            "Listed from your signed-in Codex account, because the slugs are "
            "specific to the CLI version and the plan — an outdated one fails "
            "the run outright with 'Model metadata not found'. Empty means "
            "whatever ~/.codex/config.toml already says. An empty list means "
            "Liffy cannot reach your Codex credentials — in Docker that is "
            "usually the ~/.codex mount, which docker-compose.subscription.yml "
            "needs uncommented for the API service too, not a sign-in problem."
        ),
        kind="str",
        applies_to=("codex",),
        allow_empty=True,
    ),
    "openai_base_url": SettingSpec(
        group="review_model",
        label="Endpoint",
        help=(
            "Where the `openai` provider sends the review. Empty is OpenAI "
            "itself; a localhost URL is Ollama, which runs the model on your "
            "own hardware and means your code never leaves the machine. "
            "Read `// where your code goes` in the README before pointing this "
            "somewhere new — it decides who sees the code being reviewed."
        ),
        kind="str",
        applies_to=("openai",),
        allow_empty=True,
        suggestions=(
            "http://localhost:11434/v1",
            "https://generativelanguage.googleapis.com/v1beta/openai/",
        ),
    ),
    "openai_model": SettingSpec(
        group="review_model",
        label="Model",
        help=(
            "`openai` is the wire format, not the vendor — the same field "
            "drives OpenAI, Gemini's compatibility endpoint, and a local "
            "Ollama. Type any model name your endpoint serves."
        ),
        kind="str",
        applies_to=("openai",),
        # One per documented endpoint in .env.example rather than a catalogue:
        # the point is to show the shape of a valid answer for each, since the
        # right value depends entirely on OPENAI_BASE_URL.
        suggestions=("gpt-4o", "gemini-2.5-flash", "qwen2.5-coder:14b"),
    ),
    "anthropic_effort": SettingSpec(
        group="review_model",
        label="Thinking effort",
        help=(
            "The real cost lever on Claude models, where thinking is on by "
            "default and bills as output tokens. `medium` is a deliberate "
            "choice for review; raise it if reviews start missing things. On "
            "`claude_code` it spends rate-limit quota rather than money, but "
            "it is the same lever."
        ),
        kind="choice",
        choices=("low", "medium", "high", "xhigh", "max"),
        # Both Claude transports: the API takes it as a request parameter and
        # the CLI as `--effort`, with the same five levels. Not `openai`, which
        # has no equivalent, and not `codex`, which reads its own
        # `model_reasoning_effort` from ~/.codex/config.toml for the same
        # reason its model does.
        applies_to=("anthropic", "claude_code"),
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
        applies_to=("openai",),
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

# Confirmed in the UI before they take a non-default value, because each reaches
# outside Liffy: one writes to somebody's pull request, one can block their
# merge, and one decides which company receives the code being reviewed.
CONFIRM_ON_ENABLE: frozenset[str] = frozenset(
    {"post_reviews_to_github", "github_review_event_mode", "openai_base_url"}
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
    "claude_code_binary": ReadOnlySetting(
        "review_model", "Claude Code binary", "Path to the CLI on the host.",
    ),
    "claude_code_timeout": ReadOnlySetting(
        "review_model", "Claude Code timeout (s)", "Set it in backend/.env.",
    ),
    "codex_binary": ReadOnlySetting(
        "review_model", "Codex binary", "Path to the CLI on the host.",
    ),
    "codex_timeout": ReadOnlySetting(
        "review_model", "Codex timeout (s)", "Set it in backend/.env.",
    ),
    "codex_home": ReadOnlySetting(
        "review_model", "Codex credential directory",
        "Only needed in Docker, where the CLI has no home directory to read. "
        "A path, not a secret — the credentials it points at never enter Liffy.",
    ),
}

@dataclass(frozen=True)
class SecretSetting:
    """A credential's *existence*, and what its absence actually means.

    ``requirement`` is the field that stops the page lying. "Not configured" is
    the correct answer for a key nobody needs, and an alarming one for a key
    the selected provider depends on — the same two words meaning "fine" and
    "broken" is not a report, it is a coin flip. Saying which of the two it is
    costs one string per secret.
    """

    label: str
    requirement: str
    # Which `llm_provider` values this credential is relevant to. Empty means
    # it is not provider-specific (Liffy's own secrets, GitHub's).
    applies_to: tuple[str, ...] = ()
    # Can be connected from the settings page instead of backend/.env.
    #
    # Off for everything by default, and it should stay that way for most of
    # these. A settings page that could write `jwt_secret_key` would be a way
    # to forge sessions, and `github_token` belongs to an account rather than
    # to this install. The subscription token is the case that earns it: it is
    # personal, it is revocable from Anthropic's side, and requiring a dotfile
    # edit to use the provider the page is offering you makes the page a liar.
    connectable: bool = False
    # The command that produces the value, shown in the connect dialog. The
    # CLI's login is a browser flow with no headless mode, so Liffy cannot run
    # it for you — it can only stop you having to edit a file afterwards.
    connect_command: str = ""


# Never sent to the frontend — not the value, not a masked value, not a length.
# The API answers `is_set: true|false` and nothing else. A dict rather than a
# tuple only so each entry can carry its label and requirement; membership and
# iteration are unchanged.
SECRET_SETTINGS: dict[str, SecretSetting] = {
    "jwt_secret_key": SecretSetting(
        "JWT secret key", "Required. Generated by liffy.sh on first run.",
    ),
    "github_client_secret": SecretSetting(
        "GitHub client secret", "Required to sign in with GitHub.",
    ),
    "github_webhook_secret": SecretSetting(
        "GitHub webhook secret", "Required for automatic reviews on push.",
    ),
    "github_token": SecretSetting(
        "GitHub token", "Required to read repositories and post reviews.",
    ),
    "anthropic_api_key": SecretSetting(
        "Anthropic API key",
        "Required by this provider — reviews fail without it.",
        applies_to=("anthropic",),
    ),
    "openai_api_key": SecretSetting(
        "OpenAI API key",
        "Required by this provider, though a local Ollama accepts any "
        "non-empty value.",
        applies_to=("openai",),
    ),
    # A long-lived credential for a personal subscription — the one thing worse
    # than leaking an API key, since revoking it means re-running the CLI's
    # login on the host.
    "claude_code_oauth_token": SecretSetting(
        "Claude Code OAuth token",
        # The reason this whole field exists: on the host it is genuinely not
        # needed, and reporting that as a bare "Not configured" sent people
        # looking for a problem they did not have.
        "Only needed in Docker. Running on the host, the CLI reads your own "
        "login and this stays empty.",
        applies_to=("claude_code",),
        connectable=True,
        connect_command="claude setup-token",
    ),
}

# The subset the settings page may write. Everything else stays .env-only, and
# `update_settings` still refuses every secret without exception — connecting
# goes through its own endpoint rather than widening the general one.
CONNECTABLE_SECRETS: tuple[str, ...] = tuple(
    key for key, spec in SECRET_SETTINGS.items() if spec.connectable
)

def redact_url_credentials(value: Any) -> Any:
    """Mask the password in a URL-shaped read-only value.

    ``database_url`` and ``redis_url`` are read-only rather than secret, and
    that is the right bucket: *where* the database lives is a real answer to
    "where is this configured?". The password to it is not. Compose ships
    ``postgresql://liffy:liffy@postgres:5432/liffy``, so publishing the value
    verbatim hands the database credentials to every authenticated user —
    which is the disclosure ``SECRET_SETTINGS`` exists to prevent, arriving
    through the bucket next to it.

    Only the password is replaced. Scheme, user, host, port and path all
    survive, so the value still identifies the server it points at. A value
    carrying no credentials comes back byte-identical.
    """
    if not isinstance(value, str) or "://" not in value:
        return value
    try:
        parts = urlsplit(value)
        password = parts.password
    except ValueError:
        # Unparseable as a URL, and it contains "://" — we cannot show that a
        # password is absent, so we do not show the value.
        return "***"
    if not password:
        return value

    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    netloc = f"{parts.username}:***@{host}" if parts.username else f"***@{host}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


# Editable settings plus the credentials the page can connect. Both are read
# through the same store, and both have to be in here or the value is written,
# reported as configured, and never actually read — which is the one outcome
# worse than not offering the control at all.
_OVERRIDABLE: frozenset[str] = frozenset(EDITABLE_SETTINGS) | frozenset(
    CONNECTABLE_SECRETS
)

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

    Rebinding the name rather than ``clear()`` then ``update()``, because the
    endpoints reading through this are sync defs and FastAPI runs those in a
    threadpool. Mutating in place leaves a window — between the clear and the
    update — in which a concurrent request sees *no* overrides and silently
    reviews with the env values. Rebinding is atomic, so a reader gets either
    the whole old mapping or the whole new one.
    """
    global _overrides
    _overrides = dict(values)


def active_overrides() -> dict[str, Any]:
    """A copy, so a caller cannot mutate the store by holding onto it."""
    return dict(_overrides)


settings = Settings()
