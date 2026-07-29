"""Review generation chain (report §7.2 steps 05-08).

``generate_review`` builds the prompt, calls the model behind the ``ReviewLLM``
seam, validates the JSON (retrying with the validation error fed back), and
anchors comment line numbers to the actual diff.
"""

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
            system=system,
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

        usage = response.usage
        return LLMResponse(
            text=text,
            tokens_used=int(usage.input_tokens) + int(usage.output_tokens),
        )


def get_llm() -> ReviewLLM:
    """Select the review transport. Constructed lazily by callers, never at import."""
    if settings.llm_provider == "openai":
        return OpenAIReviewLLM()
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
