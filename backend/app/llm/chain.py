"""Review generation chain (report §7.2 steps 05-08).

``generate_review`` builds the prompt, calls the model behind the ``ReviewLLM``
seam, validates the JSON (retrying with the validation error fed back), and
anchors comment line numbers to the actual diff.
"""

import atexit
import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Protocol

from app.config import settings
from app.llm.output_parser import LLMOutputError, parse_llm_output
from app.llm.prompts import SYSTEM_PROMPT, build_review_prompt
from app.schemas.review import LLMReviewOutput
from app.services.diff_parser import FileDiff, FileStatus
from app.services.rag_service import RetrievedChunk

DEFAULT_MAX_RETRIES = 2

_RETRY_SUFFIX = """

Your previous output failed validation:
{error}

Return the corrected review as ONLY a valid JSON object matching the schema. No other text."""

# A GitHub suggestion block is pasted into the changed file. A sentence that
# describes a fix is therefore actively harmful: it looks like a patch while
# leaving the author with prose in their source. The prompt tells the model to
# return replacement text only, and this small last-mile guard protects the
# publisher when a provider ignores that instruction.
def _is_prose_suggestion(value: str | None) -> bool:
    if not value or not value.strip():
        return False
    suggestion = value.strip()
    # Markdown fences are never part of the replacement text. A single
    # backtick, however, is valid inside a template literal, shell command, or
    # Markdown replacement and is not enough to classify the whole suggestion.
    if "```" in suggestion:
        return True

    # A one-line sentence with no code punctuation is prose. Keep ordinary
    # expression/statement suggestions such as `return value`, template
    # literals, and identifiers such as `shouldRender` or `must_be_valid`.
    if "\n" not in suggestion and suggestion.endswith((".", "!", "?")):
        if not re.search(
            r"[=;{}()[\]<>]|\b(return|const|let|var|def|class|import|from)\b|^\s{0,3}#{1,6}\s",
            suggestion,
        ):
            return True
    return False


def _remove_prose_suggestions(output: LLMReviewOutput) -> LLMReviewOutput:
    """Keep comments, but never publish prose as a pasteable suggestion."""
    return output.model_copy(
        update={
            "comments": [
                comment.model_copy(update={"suggestion": None})
                if _is_prose_suggestion(comment.suggestion)
                else comment
                for comment in output.comments
            ]
        }
    )


@dataclass
class LLMResponse:
    text: str
    # ``None`` means *unknown*, not zero. A provider that cannot report usage
    # must say so: a 0 reads as "this review was free", and since the §8 metrics
    # divide by token counts, a fabricated zero corrupts them silently while a
    # None is filtered out (see ``eval_service.py`` — it already excludes both
    # NULL and 0 rows, which is what makes this distinction safe to introduce).
    tokens_used: int | None = 0


class ReviewLLM(Protocol):
    model_name: str

    def complete(self, system: str, user: str) -> LLMResponse: ...


class OpenAIReviewLLM:
    """LangChain ChatOpenAI transport. Constructed lazily so tests never need a key."""

    def __init__(self, model: str | None = None, api_key: str | None = None) -> None:
        from langchain_openai import ChatOpenAI

        from app.schemas.review import LLMReviewOutput

        self.model_name = model or settings.openai_model

        # "json_object" only demands *valid JSON* — not *our* JSON. Large models
        # infer the schema from the system prompt anyway, but a small local one
        # will happily return a well-formed document of its own invention:
        # qwen2.5-coder:7b wrapped everything in a "review" key and added a
        # "strengths" array, failing validation on all three attempts.
        #
        # "json_schema" constrains generation to the schema itself, which fixes
        # that. It is opt-in because support varies across OpenAI-compatible
        # endpoints — Ollama and OpenAI implement it, and a provider that does
        # not will reject the request outright rather than degrade.
        if settings.openai_use_json_schema:
            response_format = {
                "type": "json_schema",
                "json_schema": {
                    "name": "review",
                    "strict": True,
                    "schema": LLMReviewOutput.model_json_schema(),
                },
            }
        else:
            response_format = {"type": "json_object"}

        self._chat = ChatOpenAI(
            model=self.model_name,
            api_key=api_key or settings.openai_api_key,
            base_url=settings.openai_base_url or None,
            temperature=0,
            model_kwargs={"response_format": response_format},
        )

    def complete(self, system: str, user: str) -> LLMResponse:
        message = self._chat.invoke([("system", system), ("human", user)])
        usage = (message.response_metadata or {}).get("token_usage", {})
        return LLMResponse(
            text=str(message.content),
            tokens_used=int(usage.get("total_tokens", 0)),
        )


class LLMRefusalError(RuntimeError):
    """The model declined the request rather than producing a review.

    Distinct from a malformed response: retrying the same prompt will not help,
    so ``generate_review``'s validation loop must not swallow this.
    """


class AnthropicReviewLLM:
    """Official Anthropic SDK transport.

    Anthropic is not OpenAI-wire-compatible, so ``OpenAIReviewLLM`` cannot be
    pointed at it with a ``base_url`` override — hence a second implementation
    of the same protocol rather than a config change.
    """

    def __init__(self, model: str | None = None, api_key: str | None = None) -> None:
        import anthropic  # deferred so tests never need the SDK configured

        self.model_name = model or settings.anthropic_model
        self._client = anthropic.Anthropic(api_key=api_key or settings.anthropic_api_key)

    def complete(self, system: str, user: str) -> LLMResponse:
        # No temperature/top_p/top_k: they are rejected outright on this model
        # family. The system prompt is a top-level parameter here, not a message
        # with role="system".
        response = self._client.messages.create(
            model=self.model_name,
            max_tokens=settings.llm_max_tokens,
            # Cached as a block rather than a bare string. SYSTEM_PROMPT is
            # byte-identical on every review and ~935 tokens, comfortably over
            # the 512-token minimum, so from the second review onward this
            # prefix bills at roughly a tenth of the input rate.
            #
            # It must stay first and stay stable: caching is a prefix match, so
            # interpolating anything volatile (a timestamp, a repo name) into
            # this block would invalidate the entry on every call and cost more
            # than not caching at all.
            system=[
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            # Thinking is on by default on this model family and bills as output
            # tokens, so effort is the main cost lever — not max_tokens, which is
            # only a ceiling. See the note on the config field for the tradeoff.
            output_config={"effort": settings.anthropic_effort},
            messages=[{"role": "user", "content": user}],
        )

        # Check before touching content: on a refusal `content` can be empty, so
        # indexing it blindly raises IndexError and surfaces as a 500 rather
        # than a cleanly failed review.
        if response.stop_reason == "refusal":
            raise LLMRefusalError(
                f"Model declined to review this diff (stop_reason=refusal, "
                f"category={getattr(response.stop_details, 'category', None)})"
            )

        # content is a list of typed blocks and a thinking block can come first,
        # so filter by type instead of indexing content[0].
        text = "".join(block.text for block in response.content if block.type == "text")
        if not text:
            raise LLMRefusalError(
                f"Model returned no text block (stop_reason={response.stop_reason})"
            )

        # Cached tokens are cheaper, not free, and once caching is on they carry
        # most of the input volume — counting only input+output would report a
        # review as far smaller than it was and skew the §8 metrics. Same
        # accounting as the Claude Code provider, so the number stays
        # comparable across providers.
        usage = response.usage
        return LLMResponse(
            text=text,
            tokens_used=(
                int(usage.input_tokens)
                + int(usage.output_tokens)
                + int(getattr(usage, "cache_read_input_tokens", 0) or 0)
                + int(getattr(usage, "cache_creation_input_tokens", 0) or 0)
            ),
        )


class SubscriptionCLIError(RuntimeError):
    """A subscription-backed CLI provider could not produce a review."""


class ClaudeCodeError(SubscriptionCLIError):
    """The Claude Code CLI could not produce a review."""


class CodexError(SubscriptionCLIError):
    """The Codex CLI could not produce a review."""


class SubscriptionLimitError(SubscriptionCLIError):
    """The subscription's own rate limit or quota was reached.

    Its own class because it is the one CLI failure that is not a bug and not a
    misconfiguration: nothing about the setup is wrong and retrying later fixes
    it. Folded into the generic error it surfaces as "did not return JSON",
    which sends the reader looking for a parser bug that is not there.
    """


class SubscriptionAuthError(SubscriptionCLIError):
    """The CLI is installed but has no usable credentials."""


# Substrings both CLIs print when the *subscription* — not an API key — runs
# out. Matched case-insensitively against stdout and stderr before any attempt
# to parse the output, because a rate-limited run exits nonzero with prose
# where the JSON should be.
_LIMIT_MARKERS = (
    "rate limit",
    "usage limit",
    "quota",
    "too many requests",
    "429",
    "resets at",
)

_AUTH_MARKERS = (
    "not logged in",
    "not authenticated",
    "please run /login",
    "please log in",
    "invalid api key",
    "oauth token has expired",
    "authentication_error",
)


def running_in_container() -> bool:
    """True when this process is inside Docker/Kubernetes.

    The subscription providers hinge on this: outside a container the CLIs read
    the credentials in the user's home directory and need nothing configured,
    inside one there is no such directory and a token is mandatory. Getting the
    answer wrong in either direction produces a confusing error, so it is one
    helper rather than a check copy-pasted into each provider.
    """
    if os.path.exists("/.dockerenv"):
        return True
    try:
        with open("/proc/1/cgroup", encoding="utf-8") as fh:
            return any(
                marker in fh.read() for marker in ("docker", "kubepods", "containerd")
            )
    except OSError:
        # No /proc at all — macOS or Windows, which means not a Linux container.
        return False


def _classify_cli_failure(
    provider: str,
    returncode: int,
    blob: str,
    error_cls: type[SubscriptionCLIError],
) -> SubscriptionCLIError:
    """Turn a failed CLI run into the most specific error the output supports.

    ``error_cls`` is the provider's own error type, used when the output says
    nothing recognisable — so an unexplained failure still arrives as the
    ``ClaudeCodeError``/``CodexError`` a caller would think to catch.
    """
    haystack = (blob or "").lower()
    if any(marker in haystack for marker in _LIMIT_MARKERS):
        return SubscriptionLimitError(
            f"{provider} hit its subscription rate limit or quota. Nothing is "
            f"misconfigured — the account is out of allowance for now. "
            f"Output: {(blob or '').strip()[:300]}"
        )
    if any(marker in haystack for marker in _AUTH_MARKERS):
        return SubscriptionAuthError(
            f"{provider} is installed but not authenticated. "
            f"Output: {(blob or '').strip()[:300]}"
        )
    return error_cls(f"{provider} exited {returncode}: {(blob or '').strip()[:300]}")


_CODEX_HOME_CACHE: dict[str, str] = {}


def _writable_codex_home(source: str) -> str:
    """A copy of the Codex credential directory that the CLI can write into.

    The mount in ``docker-compose.subscription.yml`` is ``:ro`` deliberately —
    the container should not be able to rewrite the host's credential store.
    But the CLI writes into ``CODEX_HOME`` while running, and against a
    read-only directory it dies with ``failed to initialize in-process
    app-server client: Read-only file system`` *after* authenticating, which
    reads as a Liffy bug rather than a mount option.

    Copying resolves both halves: the CLI gets a writable home, the host store
    stays read-only. The copy lasts for the life of the process, so a token the
    CLI refreshes into it is lost on restart — which is the price of not
    granting write access to the real one, and cheap next to re-running a login.

    A source that is already writable is used as-is; that is the host case,
    where this whole dance is unnecessary.
    """
    if source in _CODEX_HOME_CACHE:
        return _CODEX_HOME_CACHE[source]
    if os.access(source, os.W_OK):
        _CODEX_HOME_CACHE[source] = source
        return source

    # Under the home directory, not /tmp: the CLI installs helper binaries into
    # CODEX_HOME and refuses outright to do that beneath a temporary directory
    # ("Refusing to create helper binaries under temporary dir").
    target = os.path.join(os.path.expanduser("~"), ".liffy-codex-home")
    os.makedirs(target, mode=0o700, exist_ok=True)
    os.chmod(target, 0o700)
    for name in ("auth.json", "config.toml"):
        origin = os.path.join(source, name)
        if os.path.isfile(origin):
            shutil.copy2(origin, os.path.join(target, name))
    # Credentials should not outlive the process that needed them.
    atexit.register(shutil.rmtree, target, True)
    _CODEX_HOME_CACHE[source] = target
    return target


# The API-key providers' credentials, per subscription CLI. These must never
# reach the CLI's child process — see `_cli_env`.
_ANTHROPIC_API_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")
_OPENAI_API_VARS = ("OPENAI_API_KEY", "OPENAI_BASE_URL")


def _cli_env(conflicting: tuple[str, ...], **credentials: str) -> dict[str, str]:
    """The child environment for a subscription CLI: our own, minus the API keys.

    Stripping is the load-bearing half, and it is not a precaution.

    Both CLIs prefer an API key over the subscription credential when they see
    both, silently. `backend/.env` holds `ANTHROPIC_API_KEY` because the
    `anthropic` provider needs it, `env_file` puts it in the worker's
    environment, and the old version of this function passed the whole
    environment through with only the subscription token *added*. Measured
    against claude-code 2.1.220 by pointing `ANTHROPIC_BASE_URL` at a local
    listener and reading the headers:

        both set  -> x-api-key: <the API key>, no authorization header
        key unset -> authorization: Bearer <the OAuth token>

    So every review that looked like it was riding the user's subscription was
    billed to their Console credits instead, and the token they connected in the
    settings page was never sent. Nothing surfaced it: the reviews worked.

    The base URLs go too. Liffy sets them to steer its *own* API clients — this
    install points `OPENAI_BASE_URL` at Google's OpenAI-compatible endpoint —
    and a subscription CLI inheriting one would be aimed somewhere its
    credentials mean nothing.

    Always returns a dict, never ``None``. Inheriting our environment wholesale
    is the bug, so there is no path here that does it.
    """
    env = {k: v for k, v in os.environ.items() if k not in conflicting}
    env.update({k: v for k, v in credentials.items() if v})
    return env


class ClaudeCodeReviewLLM:
    """Drives the locally-installed Claude Code CLI as a completion endpoint.

    This is the only provider that needs no API key: Claude Code authenticates
    with the user's own Pro/Max subscription, so a self-hosted Liffy can review
    with credentials the user already has. See #170 for the reasoning.

    It is deliberately *not* the default. Claude Code injects its own system
    prompt and tool definitions on every invocation — measured at roughly 17k
    tokens of overhead for a 9-token answer — which on an API key is strictly
    worse than calling the API directly. On a subscription that overhead costs
    rate-limit quota rather than money, which is the trade this provider is for.
    """

    # Claude Code is an agent; we want a completion. Nothing here should touch
    # the filesystem or the network on our behalf — Liffy already did its own
    # retrieval and hands over the finished prompt.
    #
    # An empty allow-list, not a deny-list. The deny-list this replaces named
    # thirteen tools and still missed `ReportFindings`, which the CLI reaches
    # for precisely when the prompt looks like a code review — so on a real pull
    # request the model filed its findings through the tool and wrote prose
    # about it, leaving no JSON anywhere in the transcript. Observed on PR #246:
    # `tool_use ReportFindings` -> `2 findings reported.` -> a summary paragraph.
    #
    # Enumerating every built-in was never going to hold; the list only has to
    # be out of date once. `--tools ""` is the CLI's own "disable all tools".
    _NO_TOOLS = ""

    def __init__(
        self,
        model: str | None = None,
        binary: str | None = None,
        timeout: float | None = None,
    ) -> None:
        self.model_name = model or settings.claude_code_model
        self._binary = binary or settings.claude_code_binary
        self._timeout = timeout if timeout is not None else settings.claude_code_timeout
        self._token = settings.claude_code_oauth_token

        if shutil.which(self._binary) is None:
            raise ClaudeCodeError(
                f"{self._binary!r} is not on PATH. Install Claude Code and sign in, "
                f"or set LLM_PROVIDER to a different provider."
            )

        # Deliberately at construction, which for this provider is startup —
        # `get_llm()` is called before the review begins. The whole point is
        # that a misconfigured subscription provider fails while someone is
        # watching, not forty seconds into a queued review where it surfaces as
        # a subprocess error against a pull request.
        if running_in_container() and not self._token:
            raise SubscriptionAuthError(
                "LLM_PROVIDER=claude_code is running inside a container, where "
                "there is no home directory holding your Claude credentials. "
                "Run `claude setup-token` on the host, then paste the result "
                "into Settings → Secrets → Connect (applies from the next "
                "review) or set CLAUDE_CODE_OAUTH_TOKEN in backend/.env. For a "
                "manual Compose invocation the worker also needs "
                "`-f docker-compose.subscription.yml`, which `./liffy.sh` adds "
                "on its own."
            )

    def _argv(self, system: str) -> list[str]:
        # The prompt goes on stdin, not in here.
        #
        # As an argv element it hit the kernel's limit on a real pull request:
        # `[Errno 7] Argument list too long`. A review prompt carries the diff
        # plus every retrieved context chunk, so it is routinely tens of
        # kilobytes — the size at which this provider is *supposed* to be used.
        # Passing it as an argument worked only for diffs small enough not to
        # matter.
        return [
            self._binary,
            "--print",
            # Not "json", which returns only the CLI's *final* assistant turn.
            #
            # Claude Code is an agent loop, and on a real pull request it takes
            # more than one turn even with every tool disabled: measured
            # `num_turns: 2` on PR #246, where turn 1 was the review JSON and
            # turn 2 was a human-facing summary ("Review complete — findings
            # reported above"). "json" handed us turn 2, the review was
            # discarded unseen, and the failure surfaced as the misleading
            # `No JSON object found in model output`.
            #
            # The full transcript has the answer in it, so read the transcript.
            # `--verbose` is not optional here — the CLI requires it alongside
            # `--print --output-format stream-json`.
            "--output-format", "stream-json",
            "--verbose",
            # The same five levels the API takes (low|medium|high|xhigh|max),
            # and the same cost lever: this provider spends rate-limit quota
            # rather than money, but effort is still what decides how much.
            # Leaving it unset meant the settings page offered an effort
            # control that silently did nothing on this provider.
            "--effort", settings.anthropic_effort,
            # Replaces Claude Code's own system prompt rather than appending to
            # it. Appending would stack Liffy's reviewer persona on top of the
            # coding-agent persona and pay for both.
            "--system-prompt", system,
            "--tools", self._NO_TOOLS,
            "--model", self.model_name,
        ]

    def complete(self, system: str, user: str) -> LLMResponse:
        # A neutral empty directory, not the repository under review. Claude
        # Code reads CLAUDE.md and picks up file context from its working
        # directory, so running it inside the repo would let the model see code
        # the RAG pipeline never selected — inflating cost and, worse, quietly
        # invalidating any measurement of retrieval quality.
        with tempfile.TemporaryDirectory(prefix="liffy-review-") as workdir:
            try:
                proc = subprocess.run(
                    self._argv(system),
                    input=user,
                    capture_output=True,
                    text=True,
                    timeout=self._timeout,
                    cwd=workdir,
                    env=_cli_env(_ANTHROPIC_API_VARS, CLAUDE_CODE_OAUTH_TOKEN=self._token),
                )
            except subprocess.TimeoutExpired as exc:
                raise ClaudeCodeError(
                    f"Claude Code timed out after {self._timeout}s"
                ) from exc

        if proc.returncode != 0:
            # Classify before reporting. A hit rate limit and a genuine crash
            # both arrive here as a nonzero exit, and telling them apart is the
            # difference between "wait" and "something is broken".
            raise _classify_cli_failure(
                "Claude Code",
                proc.returncode,
                f"{proc.stderr or ''}\n{proc.stdout or ''}",
                ClaudeCodeError,
            ) from None

        payload, turns, tools = _claude_code_stream(proc.stdout)
        if payload is None:
            # Never let a raw JSONDecodeError escape — it reads as a bug in the
            # output parser rather than a CLI that printed something unexpected.
            raise ClaudeCodeError(
                f"Claude Code did not return JSON: {proc.stdout.strip()[:300]!r}"
            )

        if payload.get("is_error") or payload.get("subtype") != "success":
            # A limit can also arrive as a clean exit with an error payload, so
            # the same classification applies here as to a nonzero exit.
            blob = json.dumps(payload)
            if any(marker in blob.lower() for marker in _LIMIT_MARKERS):
                raise _classify_cli_failure("Claude Code", 0, blob, ClaudeCodeError)
            raise ClaudeCodeError(
                f"Claude Code reported failure "
                f"(subtype={payload.get('subtype')}, "
                f"api_error_status={payload.get('api_error_status')})"
            )

        # Last turn that actually carries a JSON object, falling back to the
        # final result text so a refusal or an empty run reports as itself.
        text = next(
            (t for t in reversed(turns) if "{" in t and "}" in t),
            payload.get("result") or "",
        )
        if not text:
            raise ClaudeCodeError(
                f"Claude Code returned no result (stop_reason={payload.get('stop_reason')})"
            )

        # A tool call means the review went somewhere we cannot read, and the
        # text is a summary of it. Say which tool, in the failure the user
        # sees. `No JSON object found in model output` was true and useless: it
        # blamed the parser, and finding `ReportFindings` took reading the CLI's
        # own session transcript inside the container.
        if tools and "{" not in text:
            raise ClaudeCodeError(
                f"Claude Code answered by calling {', '.join(sorted(set(tools)))} "
                f"instead of returning the review. Tools are supposed to be off "
                f"for this provider. It said: {text.strip()[:200]!r}"
            )

        return LLMResponse(text=text, tokens_used=_claude_code_tokens(payload))


def _claude_code_stream(stdout: str) -> tuple[dict | None, list[str], list[str]]:
    """Split a `--output-format stream-json` transcript into result, turns, tools.

    Returns the terminating ``result`` event, every assistant text block in
    order, and the name of every tool the model called. ``None`` for the result
    means the CLI printed something that was not a transcript at all, which the
    caller reports as such.

    The tool names exist for the error message. A model that answers by calling
    a tool leaves no JSON behind, and without the names the failure is
    indistinguishable from a model that simply wrote prose.

    Thinking blocks are skipped deliberately: with `--effort high` the model
    reasons about the schema before emitting it, and reasoning that *discusses*
    JSON would otherwise outrank the JSON.

    Malformed lines are skipped rather than fatal. The transcript is a stream,
    and one unparseable line — a warning the CLI decided to print mid-run — is
    not a reason to throw away a review that completed.
    """
    result: dict | None = None
    turns: list[str] = []
    tools: list[str] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "result":
            result = event
        elif event.get("type") == "assistant":
            for block in (event.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text":
                    turns.append(block.get("text") or "")
                elif block.get("type") == "tool_use":
                    tools.append(str(block.get("name") or "?"))
    return result, turns, tools


def _claude_code_tokens(payload: dict) -> int:
    """Total tokens processed across every model the CLI used for this call.

    Two things make this less obvious than it looks.

    A single invocation can span more than one model — a small one for internal
    bookkeeping alongside the one that answers — so the top-level ``usage``
    block describes only part of the work.

    More importantly, Claude Code caches its own prompt aggressively, so nearly
    all the volume lands in the cache fields: a call reporting ``inputTokens=2``
    can have read 12,000 cached tokens and written 2,800 more. Counting only
    input+output would under-report a review by an order of magnitude and make
    the persisted ``tokens_used`` useless for the §8 metrics.

    Cached tokens are cheaper, not free, so they belong in the total. For
    providers that do no caching the cache fields are zero and this degrades to
    input+output, which keeps the number comparable across providers.
    """
    per_model = payload.get("modelUsage") or {}
    if per_model:
        return sum(
            int(m.get("inputTokens", 0))
            + int(m.get("outputTokens", 0))
            + int(m.get("cacheReadInputTokens", 0))
            + int(m.get("cacheCreationInputTokens", 0))
            for m in per_model.values()
        )
    usage = payload.get("usage") or {}
    return (
        int(usage.get("input_tokens", 0))
        + int(usage.get("output_tokens", 0))
        + int(usage.get("cache_read_input_tokens", 0))
        + int(usage.get("cache_creation_input_tokens", 0))
    )


class CodexReviewLLM:
    """Drives the locally-installed Codex CLI as a completion endpoint.

    The ChatGPT-subscription counterpart to ``ClaudeCodeReviewLLM``, and shaped
    to match it. Two differences are forced by the CLI rather than chosen:

    ``codex exec`` has **no system-prompt flag**, so the reviewer persona is
    prepended to the user prompt instead of replacing an agent persona. Codex
    also has no ``--disallowed-tools``; the sandbox is the control instead —
    ``-s read-only`` in an empty temporary directory leaves its tools with
    nothing to reach, which is the same guarantee by a different route.
    """

    def __init__(
        self,
        model: str | None = None,
        binary: str | None = None,
        timeout: float | None = None,
    ) -> None:
        # `model_name` is persisted as a review's `model_used`, so when the
        # model is left to the CLI it has to say that rather than report an
        # empty string as if nothing ran.
        self._model = model or settings.codex_model
        self.model_name = self._model or "codex (CLI default)"
        self._binary = binary or settings.codex_binary
        self._timeout = timeout if timeout is not None else settings.codex_timeout
        self._codex_home = settings.codex_home

        if shutil.which(self._binary) is None:
            raise CodexError(
                f"{self._binary!r} is not on PATH. Install the Codex CLI and run "
                f"`codex login`, or set LLM_PROVIDER to a different provider."
            )

        # Codex is host-only unless CODEX_HOME is explicitly configured, and
        # that is a property of the CLI rather than a decision Liffy made.
        # Measured against codex-cli 0.146: no auth environment variable exists,
        # and `codex login --with-access-token` rejects a ChatGPT subscription
        # token outright ("agent identity JWT payload is not valid JSON"). So
        # unlike Claude Code there is no token to copy in — only the credential
        # directory itself, which the operator has to opt into mounting.
        if running_in_container() and not self._codex_home:
            raise SubscriptionAuthError(
                "LLM_PROVIDER=codex is running inside a container, where there "
                "is no home directory holding your Codex credentials — and the "
                "Codex CLI has no token-based login to work around it. Run "
                "`codex login` on the host and rerun `./liffy.sh`, which mounts "
                "~/.codex into the worker and sets CODEX_HOME once that "
                "directory exists (unless LIFFY_NO_CODEX_MOUNT=1). Otherwise "
                "run the worker on the host, or use LLM_PROVIDER=claude_code, "
                "which does support a token. See docker-compose.codex.yml for "
                "what the mount grants."
            )

        if self._codex_home:
            self._codex_home = _writable_codex_home(self._codex_home)

        self._preflight()

    def _preflight(self) -> None:
        """Confirm the CLI is actually signed in, before any review depends on it.

        Codex is checkable for free — ``codex login status`` reads local state
        and calls nothing — so there is no reason to discover an expired login
        by burning a review on it. Claude Code has no equivalent free probe, and
        a live probe there would spend real subscription quota on every worker
        start, so that provider verifies its credentials only where it can do so
        without cost: the container-token check above.
        """
        try:
            proc = subprocess.run(
                [self._binary, "login", "status"],
                capture_output=True,
                text=True,
                timeout=30,
                env=_cli_env(_OPENAI_API_VARS, CODEX_HOME=self._codex_home),
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise CodexError(f"`{self._binary} login status` did not respond") from exc

        # Read the output, not the exit code. `codex login status` exits 0 while
        # printing "Not logged in" — trusting the status here would let an
        # unauthenticated worker start cleanly and fail on its first review,
        # which is the exact behaviour this preflight exists to prevent.
        combined = f"{proc.stdout or ''}{proc.stderr or ''}"
        if proc.returncode != 0 or "not logged in" in combined.lower():
            raise SubscriptionAuthError(
                f"The Codex CLI is installed but not signed in. Run `codex login` "
                f"on the host. ({combined.strip()[:200]})"
            )

    def _argv(self, workdir: str) -> list[str]:
        model_flag = ["--model", self._model] if self._model else []
        return [
            self._binary,
            "exec",
            "--json",
            # Liffy hands over a finished prompt; nothing here should read the
            # filesystem, and `workdir` is an empty temp dir precisely so that
            # `read-only` has nothing to see. Same reasoning as the Claude Code
            # provider's disabled tools.
            "--sandbox", "read-only",
            "-C", workdir,
            # The temp dir is not a git repo, and a review must not leave
            # session files behind on a worker that reviews all day.
            "--skip-git-repo-check",
            "--ephemeral",
            # Override the user's config so reviews use the effort selected in
            # Liffy rather than silently inheriting ~/.codex/config.toml.
            "-c", f"model_reasoning_effort={settings.codex_effort}",
            *model_flag,
            "--color", "never",
            # `-` is the CLI's own spelling of "read the prompt from stdin".
            # Same reason as the Claude provider: a review prompt is far too
            # large to be an argv element.
            "-",
        ]

    def complete(self, system: str, user: str) -> LLMResponse:
        prompt = f"{system}\n\n{user}"
        with tempfile.TemporaryDirectory(prefix="liffy-review-") as workdir:
            try:
                proc = subprocess.run(
                    self._argv(workdir),
                    # Closes stdin after writing, so the CLI stops reading and
                    # answers rather than waiting for more input.
                    input=prompt,
                    capture_output=True,
                    text=True,
                    timeout=self._timeout,
                    cwd=workdir,
                    env=_cli_env(_OPENAI_API_VARS, CODEX_HOME=self._codex_home),
                )
            except subprocess.TimeoutExpired as exc:
                raise CodexError(f"Codex timed out after {self._timeout}s") from exc

        if proc.returncode != 0:
            raise _classify_cli_failure(
                "Codex",
                proc.returncode,
                f"{proc.stderr or ''}\n{proc.stdout or ''}",
                CodexError,
            ) from None

        text, usage, failure = _codex_events(proc.stdout)
        if failure is not None:
            raise _classify_cli_failure("Codex", 0, failure, CodexError)
        if not text:
            raise CodexError(
                f"Codex returned no agent message. This usually means the event "
                f"format changed — Liffy expects `item.completed` events carrying "
                f"an `agent_message` item, as emitted by codex-cli 0.146. "
                f"Output: {proc.stdout.strip()[:300]!r}"
            )

        return LLMResponse(text=text, tokens_used=_codex_tokens(usage))


def _codex_events(stdout: str) -> tuple[str, dict | None, str | None]:
    """Pull the answer, the usage block, and any failure out of `--json` output.

    ``codex exec --json`` emits JSONL, one event per line, and is tolerant by
    design: unrecognised lines are skipped rather than raising, so a new event
    type in a future release adds noise instead of breaking reviews.
    """
    text_parts: list[str] = []
    usage: dict | None = None
    failure: str | None = None

    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue

        kind = event.get("type")
        if kind == "item.completed":
            item = event.get("item") or {}
            if item.get("type") == "agent_message" and item.get("text"):
                text_parts.append(str(item["text"]))
        elif kind == "turn.completed":
            raw = event.get("usage")
            usage = raw if isinstance(raw, dict) else None
        elif kind in ("turn.failed", "error"):
            failure = json.dumps(event)

    return "\n".join(text_parts), usage, failure


def _codex_tokens(usage: dict | None) -> int | None:
    """Total tokens for a Codex call, or ``None`` when the CLI did not say.

    Deliberately *not* the same arithmetic as ``_claude_code_tokens``. Codex
    reports ``cached_input_tokens`` as the cached *portion of*
    ``input_tokens`` — a real call showed 13,220 input of which 8,960 was
    cached — where Claude Code reports its cache fields alongside, not inside,
    the input count. Summing all four here the way the Claude path does would
    double-count the cache and inflate every review.

    ``reasoning_output_tokens`` is likewise already inside ``output_tokens``.

    Returns ``None`` rather than 0 when no usage event arrived: unknown and
    free are different claims, and only one of them is true.
    """
    if not usage:
        return None
    try:
        return int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0))
    except (TypeError, ValueError):
        return None


def get_llm() -> ReviewLLM:
    """Select the review transport. Constructed lazily by callers, never at import."""
    if settings.llm_provider == "openai":
        return OpenAIReviewLLM()
    if settings.llm_provider == "claude_code":
        return ClaudeCodeReviewLLM()
    if settings.llm_provider == "codex":
        return CodexReviewLLM()
    return AnthropicReviewLLM()


def _accumulate_tokens(total: int | None, reported: int | None) -> int | None:
    """Add a call's usage to the running total; ``None`` poisons the sum.

    A review can take several attempts, and if any one of them reported no
    usage the total is genuinely unknown — not "the sum of the ones that did
    answer", which would look like a complete number while under-reporting.
    """
    if total is None or reported is None:
        return None
    return total + reported


@dataclass
class ReviewResult:
    output: LLMReviewOutput
    model_used: str
    tokens_used: int | None = 0
    dropped_comments: int = 0
    raw_attempts: int = 1
    context_files: list[str] = field(default_factory=list)


def _changed_ranges(file_diffs: list[FileDiff]) -> dict[str, list[tuple[int, int]]]:
    """New-file line ranges per path that a comment may legitimately target."""
    ranges: dict[str, list[tuple[int, int]]] = {}
    for fd in file_diffs:
        if fd.status == FileStatus.deleted or fd.is_binary:
            continue
        ranges[fd.path] = [hunk.new_line_range for hunk in fd.hunks]
    return ranges


def _anchor_comments(
    output: LLMReviewOutput, file_diffs: list[FileDiff]
) -> tuple[LLMReviewOutput, int]:
    """Keep comments that land inside the diff; clamp ranges to their hunk.

    A hallucinated file or line range drops that comment (counted), never the
    whole review.
    """
    valid = _changed_ranges(file_diffs)
    kept = []
    dropped = 0
    for comment in output.comments:
        ranges = valid.get(comment.file)
        if not ranges:
            dropped += 1
            continue
        overlap = next(
            (r for r in ranges if comment.line_start <= r[1] and comment.line_end >= r[0]),
            None,
        )
        if overlap is None:
            dropped += 1
            continue
        kept.append(
            comment.model_copy(
                update={
                    "line_start": max(comment.line_start, overlap[0]),
                    "line_end": min(comment.line_end, overlap[1]),
                }
            )
        )
    return output.model_copy(update={"comments": kept}), dropped


def generate_review(
    llm: ReviewLLM,
    pr_title: str,
    file_diffs: list[FileDiff],
    context_chunks: list[RetrievedChunk],
    *,
    max_retries: int = DEFAULT_MAX_RETRIES,
) -> ReviewResult:
    user_prompt = build_review_prompt(pr_title, file_diffs, context_chunks)
    tokens: int | None = 0
    attempts = 0
    last_error: LLMOutputError | None = None

    for attempt in range(max_retries + 1):
        attempts = attempt + 1
        response = llm.complete(SYSTEM_PROMPT, user_prompt)
        tokens = _accumulate_tokens(tokens, response.tokens_used)
        try:
            output = parse_llm_output(response.text)
            break
        except LLMOutputError as exc:
            last_error = exc
            user_prompt = build_review_prompt(pr_title, file_diffs, context_chunks)
            user_prompt += _RETRY_SUFFIX.format(error=exc)
    else:
        assert last_error is not None
        raise last_error

    output, dropped = _anchor_comments(output, file_diffs)
    output = _remove_prose_suggestions(output)
    return ReviewResult(
        output=output,
        model_used=llm.model_name,
        tokens_used=tokens,
        dropped_comments=dropped,
        raw_attempts=attempts,
        context_files=sorted({c.file_path for c in context_chunks}),
    )
