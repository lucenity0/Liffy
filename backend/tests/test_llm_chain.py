import json

import pytest

from app.config import settings
from app.llm.chain import generate_review
from app.llm.output_parser import LLMOutputError
from app.llm.prompts import SYSTEM_PROMPT, build_review_prompt
from app.services.diff_parser import parse_diff
from app.services.rag_service import RetrievedChunk

DIFF = """\
diff --git a/app/util.py b/app/util.py
--- a/app/util.py
+++ b/app/util.py
@@ -10,4 +10,5 @@ def helper():
 context
-old
+new
+extra
 context
"""
# hunk covers new-file lines 10-14

CONTEXT = [
    RetrievedChunk(
        file_path="app/other.py",
        start_line=1,
        end_line=6,
        kind="function",
        name="similar_fn",
        text="def similar_fn():\n    return 'existing implementation'",
        distance=0.12,
    )
]


from conftest import FakeLLM


def _payload(comments: list[dict]) -> str:
    return json.dumps(
        {"summary": "Reviewed.", "verdict": "comment", "comments": comments}
    )


def _comment(file: str, start: int, end: int) -> dict:
    return {
        "file": file,
        "line_start": start,
        "line_end": end,
        "category": "logic_error",
        "severity": "warning",
        "comment": "Possible bug.",
        "suggestion": None,
    }


def test_happy_path_keeps_in_diff_comment() -> None:
    llm = FakeLLM([_payload([_comment("app/util.py", 11, 12)])])
    result = generate_review(llm, "Fix util", parse_diff(DIFF), CONTEXT)

    assert result.model_used == "fake-model"
    assert result.tokens_used == 100
    assert result.raw_attempts == 1
    assert result.dropped_comments == 0
    assert len(result.output.comments) == 1
    assert result.context_files == ["app/other.py"]
    # prompt carried the persona, diff hunk header, and retrieved context
    system, user = llm.prompts[0]
    assert system == SYSTEM_PROMPT
    assert "# app/util.py lines 10-14" in user
    assert "similar_fn" in user


def test_out_of_diff_comments_are_dropped_not_fatal() -> None:
    llm = FakeLLM(
        [
            _payload(
                [
                    _comment("app/util.py", 11, 12),  # valid
                    _comment("app/nonexistent.py", 5, 6),  # hallucinated file
                    _comment("app/util.py", 500, 501),  # out-of-range lines
                ]
            )
        ]
    )
    result = generate_review(llm, "Fix util", parse_diff(DIFF), CONTEXT)
    assert len(result.output.comments) == 1
    assert result.dropped_comments == 2


def test_line_range_is_clamped_to_hunk() -> None:
    llm = FakeLLM([_payload([_comment("app/util.py", 1, 50)])])
    result = generate_review(llm, "Fix util", parse_diff(DIFF), CONTEXT)
    comment = result.output.comments[0]
    assert (comment.line_start, comment.line_end) == (10, 14)


def test_retry_feeds_validation_error_back() -> None:
    llm = FakeLLM(["not json at all", _payload([_comment("app/util.py", 11, 11)])])
    result = generate_review(llm, "Fix util", parse_diff(DIFF), CONTEXT)

    assert result.raw_attempts == 2
    assert result.tokens_used == 200  # both attempts billed
    retry_user = llm.prompts[1][1]
    assert "failed validation" in retry_user
    assert "No JSON object" in retry_user
    # retry prompt still contains the diff (fresh, not doubly-suffixed)
    assert "# app/util.py lines 10-14" in retry_user
    assert retry_user.count("failed validation") == 1


def test_retries_exhausted_raises() -> None:
    llm = FakeLLM(["bad", "worse", "still bad"])
    with pytest.raises(LLMOutputError):
        generate_review(llm, "Fix util", parse_diff(DIFF), CONTEXT, max_retries=2)
    assert len(llm.prompts) == 3


def test_prompt_builder_handles_empty_inputs() -> None:
    prompt = build_review_prompt("Empty PR", [], [])
    assert "(empty diff)" in prompt
    assert "(no similar code found)" in prompt


# ── AnthropicReviewLLM (LLM-1) ────────────────────────────────────────────────


class _Block:
    def __init__(self, type_: str, text: str = "") -> None:
        self.type = type_
        self.text = text


class _Usage:
    def __init__(self, input_tokens: int, output_tokens: int) -> None:
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _Response:
    def __init__(self, content, stop_reason="end_turn", usage=None, stop_details=None):
        self.content = content
        self.stop_reason = stop_reason
        self.usage = usage or _Usage(100, 50)
        self.stop_details = stop_details


class _FakeMessages:
    def __init__(self, response) -> None:
        self._response = response
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        return self._response


def _anthropic_llm(response) -> tuple:
    """Build an AnthropicReviewLLM with its client replaced. Never touches the network."""
    from app.llm.chain import AnthropicReviewLLM

    llm = AnthropicReviewLLM.__new__(AnthropicReviewLLM)
    llm.model_name = "claude-opus-5"
    messages = _FakeMessages(response)
    llm._client = type("C", (), {"messages": messages})()
    return llm, messages


def test_anthropic_llm_satisfies_protocol() -> None:
    llm, _ = _anthropic_llm(_Response([_Block("text", "{}")]))
    assert isinstance(llm.model_name, str)
    assert callable(llm.complete)


def test_anthropic_llm_reports_token_usage() -> None:
    llm, _ = _anthropic_llm(_Response([_Block("text", "{}")], usage=_Usage(1200, 340)))

    result = llm.complete("sys", "user")

    assert result.tokens_used == 1540  # input + output


def test_anthropic_llm_extracts_text_block() -> None:
    """A thinking block can come first, so content[0] is not the answer."""
    llm, _ = _anthropic_llm(
        _Response([_Block("thinking", ""), _Block("text", '{"verdict": "approve"}')])
    )

    assert llm.complete("sys", "user").text == '{"verdict": "approve"}'


def test_anthropic_refusal_raises_cleanly() -> None:
    """stop_reason=refusal leaves content empty; content[0] would IndexError."""
    from app.llm.chain import LLMRefusalError

    llm, _ = _anthropic_llm(_Response([], stop_reason="refusal"))

    with pytest.raises(LLMRefusalError):
        llm.complete("sys", "user")


def test_anthropic_empty_text_raises_cleanly() -> None:
    from app.llm.chain import LLMRefusalError

    llm, _ = _anthropic_llm(_Response([_Block("thinking", "")], stop_reason="max_tokens"))

    with pytest.raises(LLMRefusalError, match="max_tokens"):
        llm.complete("sys", "user")


def test_anthropic_sends_system_as_top_level_param() -> None:
    """Not a message with role=system, and no sampling params (they 400)."""
    llm, messages = _anthropic_llm(_Response([_Block("text", "{}")]))

    llm.complete("SYSTEM PROMPT", "USER PROMPT")

    assert messages.kwargs["system"] == "SYSTEM PROMPT"
    assert messages.kwargs["messages"] == [{"role": "user", "content": "USER PROMPT"}]
    for banned in ("temperature", "top_p", "top_k"):
        assert banned not in messages.kwargs
    assert messages.kwargs["max_tokens"] == settings.llm_max_tokens


def test_get_llm_selects_on_config(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.llm.chain import AnthropicReviewLLM, get_llm

    monkeypatch.setattr(settings, "llm_provider", "anthropic")
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-not-real")
    assert isinstance(get_llm(), AnthropicReviewLLM)


def test_refusal_is_not_swallowed_by_the_retry_loop() -> None:
    """A refusal is not a formatting problem — retrying the same prompt cannot fix it."""
    from app.llm.chain import LLMRefusalError, generate_review

    class RefusingLLM:
        model_name = "claude-opus-5"
        calls = 0

        def complete(self, system: str, user: str):
            RefusingLLM.calls += 1
            raise LLMRefusalError("declined")

    llm = RefusingLLM()
    with pytest.raises(LLMRefusalError):
        generate_review(llm, "PR", [], [])

    assert RefusingLLM.calls == 1  # not retried
