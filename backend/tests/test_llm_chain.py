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


def test_anchoring_cannot_catch_a_wrong_line_inside_a_hunk() -> None:
    """The limit #227 turns on, pinned so nobody mistakes `_anchor_comments`
    for protection against mis-attribution.

    It answers "is this line in the diff", which is not "is this the right
    line". On a *new* file the distinction collapses entirely: the whole file
    is one hunk, so every line is in the diff and the clamp is a no-op. That is
    exactly PR #58, where all four wrong line numbers passed this guard
    untouched and reached the review.

    The fix therefore had to be upstream — number the lines in the prompt
    (`numbered_chunk_text`) so the model never has to count — because there is
    no downstream check that could have caught this.
    """
    raw = (
        "diff --git a/setup.sh b/setup.sh\n"
        "new file mode 100755\n"
        "--- /dev/null\n"
        "+++ b/setup.sh\n"
        "@@ -0,0 +1,186 @@\n" + "\n".join(f"+line {i}" for i in range(1, 187)) + "\n"
    )
    # The finding belongs on line 40; the model said 68. Both are "in the diff".
    llm = FakeLLM([_payload([_comment("setup.sh", 68, 68)])])
    result = generate_review(llm, "Add setup", parse_diff(raw), [])

    assert result.dropped_comments == 0
    comment = result.output.comments[0]
    assert (comment.line_start, comment.line_end) == (68, 68), (
        "the clamp cannot move a line that is already inside the hunk"
    )


def test_prompt_numbers_every_diff_line_for_the_model() -> None:
    """The actual #227 fix, asserted where the model receives it."""
    llm = FakeLLM([_payload([_comment("app/util.py", 11, 12)])])
    generate_review(llm, "Fix util", parse_diff(DIFF), CONTEXT)

    _, user = llm.prompts[0]
    assert "11 +new" in user
    assert "12 +extra" in user


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
    # Pin the host case. Without this the suite passes or fails depending on
    # where it runs — the container guard fires for real when CI executes
    # inside Docker, which is exactly what it is supposed to do.
    monkeypatch.setattr(chain, "running_in_container", lambda: False)
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


def test_claude_code_passes_the_configured_effort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The settings page offers an effort control; it has to reach this provider.

    The CLI takes the same five levels as the API (`--effort low|medium|high|
    xhigh|max`). Without this the control rendered, saved, and changed nothing
    — the worst kind of setting.
    """
    monkeypatch.setattr(settings, "anthropic_effort", "xhigh")
    llm, calls = _claude_code(monkeypatch)
    llm.complete("sys", "user")

    argv = calls["argv"]
    assert argv[argv.index("--effort") + 1] == "xhigh"


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
    monkeypatch.setattr(chain, "running_in_container", lambda: False)
    with pytest.raises(chain.ClaudeCodeError, match="not on PATH"):
        chain.ClaudeCodeReviewLLM()


def test_get_llm_selects_claude_code_on_config(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.llm import chain

    monkeypatch.setattr(settings, "llm_provider", "claude_code")
    monkeypatch.setattr(chain.shutil, "which", lambda _b: "/usr/local/bin/claude")
    monkeypatch.setattr(chain, "running_in_container", lambda: False)
    assert isinstance(chain.get_llm(), chain.ClaudeCodeReviewLLM)


# ── Subscription providers in a container (LLM-SUB-1) ─────────────────────────
#
# The gap this issue exists to close: `claude_code` was reachable from the
# settings page while `liffy.sh` ran the worker in Docker, where the CLI has no
# credentials to read. It failed mid-review with a subprocess error. These tests
# pin the replacement behaviour — fail at construction, say why, say the fix.


def test_container_without_token_is_rejected_at_startup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.llm import chain

    monkeypatch.setattr(chain.shutil, "which", lambda _b: "/usr/local/bin/claude")
    monkeypatch.setattr(chain, "running_in_container", lambda: True)
    monkeypatch.setattr(settings, "claude_code_oauth_token", "")

    with pytest.raises(chain.SubscriptionAuthError) as exc:
        chain.ClaudeCodeReviewLLM()

    # The message has to carry the remedy, not just the diagnosis: this is the
    # only thing the operator sees.
    assert "claude setup-token" in str(exc.value)
    assert "CLAUDE_CODE_OAUTH_TOKEN" in str(exc.value)


def test_container_with_token_constructs(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.llm import chain

    monkeypatch.setattr(chain.shutil, "which", lambda _b: "/usr/local/bin/claude")
    monkeypatch.setattr(chain, "running_in_container", lambda: True)
    monkeypatch.setattr(settings, "claude_code_oauth_token", "sk-ant-oat01-test")

    assert isinstance(chain.ClaudeCodeReviewLLM(), chain.ClaudeCodeReviewLLM)


def test_oauth_token_is_passed_to_the_subprocess(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "claude_code_oauth_token", "sk-ant-oat01-test")
    llm, calls = _claude_code(monkeypatch)
    llm.complete("sys", "user")

    env = calls["kwargs"]["env"]
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat01-test"
    # Inherited, not replaced — dropping PATH would leave the CLI unable to
    # find node.
    assert "PATH" in env


def test_no_token_inherits_the_ambient_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The host path must not change: the CLI reads ~/.claude as it always did."""
    monkeypatch.setattr(settings, "claude_code_oauth_token", "")
    llm, calls = _claude_code(monkeypatch)
    llm.complete("sys", "user")

    assert calls["kwargs"]["env"] is None


def test_rate_limit_is_distinguishable_from_a_parse_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A spent subscription is not a bug, and must not read like one."""
    from app.llm import chain

    llm, _ = _claude_code(
        monkeypatch,
        stdout="Claude usage limit reached. Your limit resets at 3pm.",
        returncode=1,
    )
    with pytest.raises(chain.SubscriptionLimitError, match="rate limit or quota"):
        llm.complete("sys", "user")


def test_rate_limit_in_a_clean_exit_payload_is_also_caught(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.llm import chain

    llm, _ = _claude_code(
        monkeypatch,
        _cc_payload(is_error=True, subtype="error", api_error_status="429"),
    )
    with pytest.raises(chain.SubscriptionLimitError):
        llm.complete("sys", "user")


def test_unauthenticated_cli_output_is_named_as_such(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.llm import chain

    llm, _ = _claude_code(
        monkeypatch, stdout="Not logged in. Run `claude` to sign in.", returncode=1
    )
    with pytest.raises(chain.SubscriptionAuthError, match="not authenticated"):
        llm.complete("sys", "user")


def test_running_in_container_is_false_on_a_bare_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.llm import chain

    monkeypatch.setattr(chain.os.path, "exists", lambda _p: False)
    assert chain.running_in_container() is False


def test_running_in_container_reads_the_docker_sentinel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.llm import chain

    monkeypatch.setattr(chain.os.path, "exists", lambda p: p == "/.dockerenv")
    assert chain.running_in_container() is True


# ── CodexReviewLLM (LLM-SUB-1) ────────────────────────────────────────────────
#
# Every payload below is real output captured from codex-cli 0.146.0 — see
# tests/fixtures/codex_exec_success.jsonl. Nothing here runs the binary or
# needs a logged-in CLI, because CI has neither.

import os
from pathlib import Path

_CODEX_SUCCESS = (
    Path(__file__).parent / "fixtures" / "codex_exec_success.jsonl"
).read_text()


def _codex(
    monkeypatch, *, stdout=None, returncode=0, raises=None, login="Logged in using ChatGPT"
):
    """Build the Codex provider with the binary faked."""
    from app.llm import chain

    monkeypatch.setattr(chain.shutil, "which", lambda _b: "/usr/local/bin/codex")
    monkeypatch.setattr(chain, "running_in_container", lambda: False)
    calls: dict = {}

    def fake_run(argv, **kwargs):
        if "login" in argv:
            calls["login_kwargs"] = kwargs
            return _Completed(login, 0)
        calls["argv"] = argv
        calls["kwargs"] = kwargs
        if raises is not None:
            raise raises
        return _Completed(stdout if stdout is not None else _CODEX_SUCCESS, returncode)

    monkeypatch.setattr(chain.subprocess, "run", fake_run)
    return chain.CodexReviewLLM(), calls


def test_codex_parses_the_agent_message(monkeypatch: pytest.MonkeyPatch) -> None:
    llm, _ = _codex(monkeypatch)
    assert llm.complete("sys", "user").text == '{"ok": true}'


def test_codex_token_count_does_not_double_count_the_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The captured run: 13,220 input (8,960 of it cached) + 9 output.

    Codex nests `cached_input_tokens` inside `input_tokens`, where Claude Code
    reports its cache fields alongside. Reusing the Claude arithmetic here would
    report 22,189 for a 13,229-token call.
    """
    llm, _ = _codex(monkeypatch)
    assert llm.complete("sys", "user").tokens_used == 13229


def test_codex_tokens_are_none_when_the_cli_reports_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Not 0 — a fabricated zero says the review was free, which is a lie."""
    no_usage = (
        '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n'
    )
    llm, _ = _codex(monkeypatch, stdout=no_usage)
    assert llm.complete("sys", "user").tokens_used is None


def test_codex_runs_in_a_neutral_sandboxed_cwd(monkeypatch: pytest.MonkeyPatch) -> None:
    import os

    llm, calls = _codex(monkeypatch)
    llm.complete("sys", "user")

    argv, kwargs = calls["argv"], calls["kwargs"]
    assert argv[argv.index("--sandbox") + 1] == "read-only"
    assert "liffy-review-" in kwargs["cwd"]
    assert os.path.abspath(kwargs["cwd"]) != os.path.abspath(os.getcwd())
    # Without DEVNULL the CLI blocks reading more prompt from stdin and the run
    # hangs to the timeout instead of answering.
    assert kwargs["stdin"] == _subprocess.DEVNULL


def test_codex_carries_the_system_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    """`codex exec` has no system-prompt flag, so it has to be prepended."""
    llm, calls = _codex(monkeypatch)
    llm.complete("SYSTEM-PERSONA", "USER-DIFF")

    prompt = calls["argv"][-1]
    assert prompt.startswith("SYSTEM-PERSONA")
    assert "USER-DIFF" in prompt


def test_codex_omits_the_model_flag_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Codex slugs are version- and account-specific; pinning one breaks runs.

    `gpt-5-codex` fails outright on codex-cli 0.146 with "Model metadata for
    `gpt-5-codex` not found", while the CLI's own config names something else
    entirely. Deferring to ~/.codex/config.toml is both likelier to work and
    the choice the user already made.
    """
    monkeypatch.setattr(settings, "codex_model", "")
    llm, calls = _codex(monkeypatch)
    llm.complete("sys", "user")

    assert "--model" not in calls["argv"]
    # Still has to name something, since this is persisted as `model_used`.
    assert llm.model_name == "codex (CLI default)"


def test_codex_honours_an_explicit_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "codex_model", "gpt-5.6-luna")
    llm, calls = _codex(monkeypatch)
    llm.complete("sys", "user")

    argv = calls["argv"]
    assert argv[argv.index("--model") + 1] == "gpt-5.6-luna"
    assert llm.model_name == "gpt-5.6-luna"


def test_codex_missing_binary_raises_actionable_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.llm import chain

    monkeypatch.setattr(chain.shutil, "which", lambda _b: None)
    monkeypatch.setattr(chain, "running_in_container", lambda: False)
    with pytest.raises(chain.CodexError, match="not on PATH"):
        chain.CodexReviewLLM()


def test_codex_preflight_detects_an_unauthenticated_cli(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`codex login status` is free, so an expired login is caught at startup.

    Asserted against the *output*, because the real CLI exits 0 while printing
    "Not logged in" — verified against codex-cli 0.146. Checking the exit code
    would let an unauthenticated worker start and fail on its first review,
    which is the failure mode this whole preflight exists to remove.
    """
    from app.llm import chain

    with pytest.raises(chain.SubscriptionAuthError, match="not signed in"):
        _codex(monkeypatch, login="Not logged in")


def test_codex_in_a_container_without_codex_home_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Codex is host-only by default, and that is the CLI's constraint.

    codex-cli 0.146 has no auth environment variable, and
    `codex login --with-access-token` rejects a ChatGPT subscription token. So
    unlike claude_code there is nothing to copy into the container, and the
    honest behaviour is to refuse at startup and say why.
    """
    from app.llm import chain

    monkeypatch.setattr(chain.shutil, "which", lambda _b: "/usr/local/bin/codex")
    monkeypatch.setattr(chain, "running_in_container", lambda: True)
    monkeypatch.setattr(settings, "codex_home", "")

    with pytest.raises(chain.SubscriptionAuthError) as exc:
        chain.CodexReviewLLM()

    message = str(exc.value)
    assert "CODEX_HOME" in message
    # It must offer the way out, not only the refusal.
    assert "claude_code" in message


def test_codex_home_is_passed_to_the_cli(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """CODEX_HOME is the only mechanism the CLI honours for a credential dir."""
    from app.llm import chain

    monkeypatch.setattr(chain, "_CODEX_HOME_CACHE", {})
    source = tmp_path / "codex-auth"
    source.mkdir()
    (source / "auth.json").write_text('{"auth_mode":"chatgpt"}')
    monkeypatch.setattr(settings, "codex_home", str(source))

    llm, calls = _codex(monkeypatch)
    llm.complete("sys", "user")

    home = calls["kwargs"]["env"]["CODEX_HOME"]
    assert home == str(source)  # writable source: used directly, no copy
    # The preflight has to look in the same place, or it validates a different
    # login than the review will use.
    assert calls["login_kwargs"]["env"]["CODEX_HOME"] == home


def test_read_only_codex_home_is_copied_somewhere_writable(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """The container case, and it is not optional.

    The compose mount is `:ro` so the container cannot rewrite the host's
    credential store — but the CLI writes into CODEX_HOME while running and dies
    against a read-only one, *after* authenticating, with "failed to initialize
    in-process app-server client: Read-only file system". Verified against
    codex-cli 0.146 before this copy existed.
    """
    from app.llm import chain

    monkeypatch.setattr(chain, "_CODEX_HOME_CACHE", {})
    source = tmp_path / "ro-auth"
    source.mkdir()
    (source / "auth.json").write_text('{"auth_mode":"chatgpt"}')
    (source / "config.toml").write_text('model = "gpt-5.6-luna"')
    monkeypatch.setattr(settings, "codex_home", str(source))

    # Unwritability is faked rather than chmod-ed, because the container runs
    # tests as root and root ignores the mode bits. The real signal is the
    # kernel's read-only bind mount, which `os.access` does report correctly
    # even to root — confirmed by a live container run copying as expected.
    real_access = os.access
    monkeypatch.setattr(
        os, "access", lambda p, m: False if str(p) == str(source) else real_access(p, m)
    )

    home_dir = tmp_path / "home"
    home_dir.mkdir()
    monkeypatch.setenv("HOME", str(home_dir))

    llm, calls = _codex(monkeypatch)
    llm.complete("sys", "user")

    home = calls["kwargs"]["env"]["CODEX_HOME"]
    assert home != str(source)
    # Not under /tmp: the CLI installs helper binaries into CODEX_HOME and
    # refuses to do so beneath a temporary directory.
    assert home.startswith(str(home_dir))
    # Both files matter: auth.json authenticates, config.toml carries the model
    # choice, and losing the latter reintroduces the "Model metadata not found"
    # failure this provider works around by not pinning a slug.
    assert (Path(home) / "auth.json").read_text() == '{"auth_mode":"chatgpt"}'
    assert (Path(home) / "config.toml").exists()


def test_codex_timeout_surfaces_as_an_llm_error(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.llm import chain

    llm, _ = _codex(
        monkeypatch, raises=_subprocess.TimeoutExpired(cmd="codex", timeout=600)
    )
    with pytest.raises(chain.CodexError, match="timed out"):
        llm.complete("sys", "user")


def test_codex_rate_limit_is_distinguishable_from_a_parse_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.llm import chain

    llm, _ = _codex(
        monkeypatch, stdout="You've hit your usage limit.", returncode=1
    )
    with pytest.raises(chain.SubscriptionLimitError, match="rate limit or quota"):
        llm.complete("sys", "user")


def test_codex_unrecognised_output_names_the_format_not_a_keyerror(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Event formats drift between CLI versions; the error must say so."""
    from app.llm import chain

    llm, _ = _codex(monkeypatch, stdout='{"type":"some.future.event"}\n')
    with pytest.raises(chain.CodexError, match="event format changed"):
        llm.complete("sys", "user")


def test_codex_skips_unparseable_lines_rather_than_failing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    noisy = "warning: something\n" + _CODEX_SUCCESS
    llm, _ = _codex(monkeypatch, stdout=noisy)
    assert llm.complete("sys", "user").text == '{"ok": true}'


def test_codex_turn_failed_is_classified(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.llm import chain

    failed = '{"type":"turn.failed","error":{"message":"rate limit exceeded"}}\n'
    llm, _ = _codex(monkeypatch, stdout=failed)
    with pytest.raises(chain.SubscriptionLimitError):
        llm.complete("sys", "user")


def test_get_llm_selects_codex_on_config(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.llm import chain

    monkeypatch.setattr(settings, "llm_provider", "codex")
    llm, _ = _codex(monkeypatch)
    assert isinstance(chain.get_llm(), chain.CodexReviewLLM)


def test_unknown_token_count_poisons_the_review_total() -> None:
    """One unknown attempt makes the whole total unknown, not a partial sum.

    A retry loop that summed only the attempts that reported usage would return
    a confident number that under-counts the review.
    """
    from app.llm.chain import _accumulate_tokens

    assert _accumulate_tokens(100, 50) == 150
    assert _accumulate_tokens(100, None) is None
    assert _accumulate_tokens(None, 50) is None


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
