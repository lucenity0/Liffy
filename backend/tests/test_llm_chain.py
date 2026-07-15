import json

import pytest

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
