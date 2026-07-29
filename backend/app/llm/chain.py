"""Review generation chain (report §7.2 steps 05-08).

``generate_review`` builds the prompt, calls the model behind the ``ReviewLLM``
seam, validates the JSON (retrying with the validation error fed back), and
anchors comment line numbers to the actual diff.
"""

import json
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


@dataclass
class LLMResponse:
    text: str
    tokens_used: int = 0


class ReviewLLM(Protocol):
    model_name: str

    def complete(self, system: str, user: str) -> LLMResponse: ...


class OpenAIReviewLLM:
    """LangChain ChatOpenAI transport. Constructed lazily so tests never need a key."""

    def __init__(self, model: str | None = None, api_key: str | None = None) -> None:
        from langchain_openai import ChatOpenAI

        self.model_name = model or settings.openai_model
        self._chat = ChatOpenAI(
            model=self.model_name,
            api_key=api_key or settings.openai_api_key,
            base_url=settings.openai_base_url or None,
            temperature=0,
            model_kwargs={"response_format": {"type": "json_object"}},
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


class ClaudeCodeError(RuntimeError):
    """The Claude Code CLI could not produce a review."""


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
    _DISABLED_TOOLS = (
        "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,"
        "NotebookEdit,TodoWrite,BashOutput,KillShell"
    )

    def __init__(
        self,
        model: str | None = None,
        binary: str | None = None,
        timeout: float | None = None,
    ) -> None:
        self.model_name = model or settings.claude_code_model
        self._binary = binary or settings.claude_code_binary
        self._timeout = timeout if timeout is not None else settings.claude_code_timeout

        if shutil.which(self._binary) is None:
            raise ClaudeCodeError(
                f"{self._binary!r} is not on PATH. Install Claude Code and sign in, "
                f"or set LLM_PROVIDER to a different provider."
            )

    def _argv(self, system: str, user: str) -> list[str]:
        return [
            self._binary,
            "--print",
            user,
            "--output-format", "json",
            # Replaces Claude Code's own system prompt rather than appending to
            # it. Appending would stack Liffy's reviewer persona on top of the
            # coding-agent persona and pay for both.
            "--system-prompt", system,
            "--disallowed-tools", self._DISABLED_TOOLS,
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
                    self._argv(system, user),
                    capture_output=True,
                    text=True,
                    timeout=self._timeout,
                    cwd=workdir,
                )
            except subprocess.TimeoutExpired as exc:
                raise ClaudeCodeError(
                    f"Claude Code timed out after {self._timeout}s"
                ) from exc

        if proc.returncode != 0:
            raise ClaudeCodeError(
                f"Claude Code exited {proc.returncode}: {(proc.stderr or '').strip()[:300]}"
            )

        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            # Never let a raw JSONDecodeError escape — it reads as a bug in the
            # output parser rather than a CLI that printed something unexpected.
            raise ClaudeCodeError(
                f"Claude Code did not return JSON: {proc.stdout.strip()[:300]!r}"
            ) from exc

        if payload.get("is_error") or payload.get("subtype") != "success":
            raise ClaudeCodeError(
                f"Claude Code reported failure "
                f"(subtype={payload.get('subtype')}, "
                f"api_error_status={payload.get('api_error_status')})"
            )

        text = payload.get("result") or ""
        if not text:
            raise ClaudeCodeError(
                f"Claude Code returned no result (stop_reason={payload.get('stop_reason')})"
            )

        return LLMResponse(text=text, tokens_used=_claude_code_tokens(payload))


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


def get_llm() -> ReviewLLM:
    """Select the review transport. Constructed lazily by callers, never at import."""
    if settings.llm_provider == "openai":
        return OpenAIReviewLLM()
    if settings.llm_provider == "claude_code":
        return ClaudeCodeReviewLLM()
    return AnthropicReviewLLM()


@dataclass
class ReviewResult:
    output: LLMReviewOutput
    model_used: str
    tokens_used: int = 0
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
    tokens = 0
    attempts = 0
    last_error: LLMOutputError | None = None

    for attempt in range(max_retries + 1):
        attempts = attempt + 1
        response = llm.complete(SYSTEM_PROMPT, user_prompt)
        tokens += response.tokens_used
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
    return ReviewResult(
        output=output,
        model_used=llm.model_name,
        tokens_used=tokens,
        dropped_comments=dropped,
        raw_attempts=attempts,
        context_files=sorted({c.file_path for c in context_chunks}),
    )
