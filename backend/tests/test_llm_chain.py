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

    # A list of blocks rather than a bare string, so the prompt can carry
    # cache_control — see test_anthropic_caches_the_system_prompt.
    assert messages.kwargs["system"][0]["text"] == "SYSTEM PROMPT"
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


def test_providers_read_separate_model_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    """A shared LLM_MODEL would send the wrong provider's model name.

    Switching LLM_PROVIDER used to leave a stale model name behind — e.g.
    "gemini-2.5-flash" sent to Anthropic, which fails as an unhelpful 404 with
    a perfectly valid key. Each provider reads its own field so a provider
    switch is a one-variable change.
    """
    from app.llm.chain import AnthropicReviewLLM

    monkeypatch.setattr(settings, "anthropic_model", "claude-opus-5")
    monkeypatch.setattr(settings, "openai_model", "gemini-2.5-flash")
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-not-real")

    llm = AnthropicReviewLLM()

    assert llm.model_name == "claude-opus-5"


# ── ClaudeCodeReviewLLM (LLM-2) ───────────────────────────────────────────────

import json as _json
import subprocess as _subprocess


def _cc_payload(**overrides) -> dict:
    """A successful `claude -p --output-format json` payload."""
    payload = {
        "is_error": False,
        "subtype": "success",
        "stop_reason": "end_turn",
        "num_turns": 1,
        "api_error_status": None,
        "result": '{"summary":"ok","verdict":"approve","comments":[]}',
        "usage": {
            "input_tokens": 2,
            "output_tokens": 9,
            "cache_read_input_tokens": 11621,
            "cache_creation_input_tokens": 2807,
        },
        "modelUsage": {
            "claude-haiku-4-5": {
                "inputTokens": 530, "outputTokens": 13,
                "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0,
            },
            "claude-opus-5": {
                "inputTokens": 2, "outputTokens": 9,
                "cacheReadInputTokens": 11621, "cacheCreationInputTokens": 2807,
            },
        },
    }
    payload.update(overrides)
    return payload


class _Completed:
    def __init__(self, stdout: str, returncode: int = 0, stderr: str = "") -> None:
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr


def _claude_code(monkeypatch, payload=None, *, stdout=None, returncode=0, raises=None):
    """Build the provider with `claude` faked. Never runs the real binary."""
    from app.llm import chain

    monkeypatch.setattr(chain.shutil, "which", lambda _b: "/usr/local/bin/claude")
    calls: dict = {}

    def fake_run(argv, **kwargs):
        calls["argv"] = argv
        calls["kwargs"] = kwargs
        if raises is not None:
            raise raises
        out = stdout if stdout is not None else _json.dumps(payload or _cc_payload())
        return _Completed(out, returncode)

    monkeypatch.setattr(chain.subprocess, "run", fake_run)
    return chain.ClaudeCodeReviewLLM(), calls


def test_claude_code_satisfies_protocol(monkeypatch: pytest.MonkeyPatch) -> None:
    llm, _ = _claude_code(monkeypatch)
    assert isinstance(llm.model_name, str)
    assert callable(llm.complete)


def test_claude_code_parses_result_and_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    llm, _ = _claude_code(monkeypatch)
    result = llm.complete("sys", "user")

    assert result.text == '{"summary":"ok","verdict":"approve","comments":[]}'
    # 543 (haiku) + 11 (opus in/out) + 14,428 (opus cache read + creation).
    # Two models in one call, and the cache fields carry nearly all the volume:
    # counting only input+output would report 554 and miss 96% of the work.
    assert result.tokens_used == 14982


def test_claude_code_falls_back_to_top_level_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    llm, _ = _claude_code(monkeypatch, _cc_payload(modelUsage={}))
    assert llm.complete("sys", "user").tokens_used == 14439  # 2+9+11621+2807


def test_claude_code_counts_cached_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    """Claude Code caches its own prompt, so input_tokens alone is misleading.

    A real call reported inputTokens=2 while reading 11,621 cached tokens and
    writing 2,807 more. Ignoring the cache fields would under-report a review
    by an order of magnitude and corrupt the §8 token metrics.
    """
    payload = _cc_payload(modelUsage={
        "claude-opus-5": {
            "inputTokens": 2, "outputTokens": 9,
            "cacheReadInputTokens": 11621, "cacheCreationInputTokens": 2807,
        },
    })
    llm, _ = _claude_code(monkeypatch, payload)
    assert llm.complete("sys", "user").tokens_used == 14439


def test_claude_code_runs_in_a_neutral_cwd(monkeypatch: pytest.MonkeyPatch) -> None:
    """The guard against reading the repository under review out of band.

    Claude Code picks up CLAUDE.md and file context from its working directory.
    Running it inside the repo would give the model code the RAG pipeline never
    selected, inflating cost and invalidating any retrieval-quality measurement.
    """
    import os

    llm, calls = _claude_code(monkeypatch)
    llm.complete("sys", "user")

    cwd = calls["kwargs"]["cwd"]
    assert cwd is not None
    assert "liffy-review-" in cwd
    assert os.path.abspath(cwd) != os.path.abspath(os.getcwd())


def test_claude_code_disables_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    llm, calls = _claude_code(monkeypatch)
    llm.complete("sys", "user")

    argv = calls["argv"]
    disabled = argv[argv.index("--disallowed-tools") + 1]
    for tool in ("Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Task"):
        assert tool in disabled


def test_claude_code_replaces_rather_than_appends_the_system_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """--append-system-prompt would stack Liffy's persona on the agent's."""
    llm, calls = _claude_code(monkeypatch)
    llm.complete("SYSTEM", "USER")

    argv = calls["argv"]
    assert "--system-prompt" in argv
    assert "--append-system-prompt" not in argv
    assert argv[argv.index("--system-prompt") + 1] == "SYSTEM"
    assert "USER" in argv


def test_claude_code_is_error_raises_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.llm.chain import ClaudeCodeError

    llm, _ = _claude_code(monkeypatch, _cc_payload(is_error=True, subtype="error_during_execution"))
    with pytest.raises(ClaudeCodeError, match="reported failure"):
        llm.complete("sys", "user")


def test_claude_code_non_json_stdout_raises_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    """An unhandled JSONDecodeError would read as a bug in the output parser."""
    from app.llm.chain import ClaudeCodeError

    llm, _ = _claude_code(monkeypatch, stdout="Not logged in. Run `claude` to sign in.")
    with pytest.raises(ClaudeCodeError, match="did not return JSON"):
        llm.complete("sys", "user")


def test_claude_code_nonzero_exit_raises_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.llm.chain import ClaudeCodeError

    llm, _ = _claude_code(monkeypatch, stdout="", returncode=1)
    with pytest.raises(ClaudeCodeError, match="exited 1"):
        llm.complete("sys", "user")


def test_claude_code_timeout_raises_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.llm.chain import ClaudeCodeError

    llm, _ = _claude_code(
        monkeypatch, raises=_subprocess.TimeoutExpired(cmd="claude", timeout=600)
    )
    with pytest.raises(ClaudeCodeError, match="timed out"):
        llm.complete("sys", "user")


def test_claude_code_empty_result_raises_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.llm.chain import ClaudeCodeError

    llm, _ = _claude_code(monkeypatch, _cc_payload(result=""))
    with pytest.raises(ClaudeCodeError, match="no result"):
        llm.complete("sys", "user")


def test_claude_code_missing_binary_raises_actionable_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.llm import chain

    monkeypatch.setattr(chain.shutil, "which", lambda _b: None)
    with pytest.raises(chain.ClaudeCodeError, match="not on PATH"):
        chain.ClaudeCodeReviewLLM()


def test_get_llm_selects_claude_code_on_config(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.llm import chain

    monkeypatch.setattr(settings, "llm_provider", "claude_code")
    monkeypatch.setattr(chain.shutil, "which", lambda _b: "/usr/local/bin/claude")
    assert isinstance(chain.get_llm(), chain.ClaudeCodeReviewLLM)


# ── Prompt caching + effort ───────────────────────────────────────────────────


def test_anthropic_caches_the_system_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    """SYSTEM_PROMPT is byte-identical every review, so it should cache.

    Sent as a block with cache_control rather than a bare string; from the
    second review onward the prefix bills at roughly a tenth of input rate.
    """
    llm, messages = _anthropic_llm(_Response([_Block("text", "{}")]))

    llm.complete("SYSTEM", "USER")

    system = messages.kwargs["system"]
    assert isinstance(system, list), "a bare string cannot carry cache_control"
    assert system[0]["text"] == "SYSTEM"
    assert system[0]["cache_control"] == {"type": "ephemeral"}


def test_anthropic_sends_effort(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "anthropic_effort", "medium")
    llm, messages = _anthropic_llm(_Response([_Block("text", "{}")]))

    llm.complete("sys", "user")

    assert messages.kwargs["output_config"] == {"effort": "medium"}


def test_anthropic_counts_cached_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    """Once caching is on, the cache fields carry most of the input volume.

    Counting only input+output would report a cached review as far smaller
    than it was and skew the §8 token metrics.
    """
    class _CachedUsage:
        input_tokens = 400
        output_tokens = 2500
        cache_read_input_tokens = 935
        cache_creation_input_tokens = 0

    llm, _ = _anthropic_llm(
        _Response([_Block("text", "{}")], usage=_CachedUsage())
    )

    assert llm.complete("sys", "user").tokens_used == 3835


def test_anthropic_token_count_survives_missing_cache_fields() -> None:
    """Older SDK responses may not carry the cache attributes at all."""
    llm, _ = _anthropic_llm(_Response([_Block("text", "{}")], usage=_Usage(100, 50)))
    assert llm.complete("sys", "user").tokens_used == 150


def test_openai_json_schema_is_opt_in(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default stays json_object: not every OpenAI-compatible endpoint
    implements json_schema, and one that does not rejects the request."""
    from app.llm import chain

    captured = {}

    class _FakeChat:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(settings, "openai_use_json_schema", False)
    monkeypatch.setitem(__import__("sys").modules, "langchain_openai",
                        type("m", (), {"ChatOpenAI": _FakeChat}))
    chain.OpenAIReviewLLM()
    assert captured["model_kwargs"]["response_format"] == {"type": "json_object"}


def test_openai_json_schema_constrains_to_the_review_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With the flag on, generation is constrained to LLMReviewOutput.

    qwen2.5-coder:7b returns a valid-JSON document of its own design under
    json_object and fails validation three times; under json_schema it
    produces a schema-valid review.
    """
    from app.llm import chain

    captured = {}

    class _FakeChat:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(settings, "openai_use_json_schema", True)
    monkeypatch.setitem(__import__("sys").modules, "langchain_openai",
                        type("m", (), {"ChatOpenAI": _FakeChat}))
    chain.OpenAIReviewLLM()

    fmt = captured["model_kwargs"]["response_format"]
    assert fmt["type"] == "json_schema"
    assert fmt["json_schema"]["strict"] is True
    props = fmt["json_schema"]["schema"]["properties"]
    assert {"summary", "verdict", "comments"} <= set(props)
