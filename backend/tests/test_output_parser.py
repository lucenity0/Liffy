import json

import pytest

from app.llm.output_parser import LLMOutputError, parse_llm_output

VALID = {
    "summary": "Small fix, looks fine.",
    "verdict": "approve",
    "comments": [
        {
            "file": "app/util.py",
            "line_start": 12,
            "line_end": 13,
            "category": "improvement",
            "severity": "info",
            "comment": "Consider a clearer name.",
            "suggestion": None,
        }
    ],
}


def test_parses_bare_json() -> None:
    out = parse_llm_output(json.dumps(VALID))
    assert out.verdict.value == "approve"
    assert out.comments[0].line_start == 12


def test_parses_fenced_json() -> None:
    raw = "```json\n" + json.dumps(VALID) + "\n```"
    assert parse_llm_output(raw).summary == VALID["summary"]


def test_parses_json_with_surrounding_prose() -> None:
    raw = "Here is my review:\n" + json.dumps(VALID) + "\nHope this helps!"
    assert len(parse_llm_output(raw).comments) == 1


def test_no_json_raises() -> None:
    with pytest.raises(LLMOutputError, match="No JSON object"):
        parse_llm_output("I could not produce a review.")


def test_malformed_json_raises() -> None:
    with pytest.raises(LLMOutputError, match="not valid JSON"):
        parse_llm_output('{"summary": "x", "verdict": }')


def test_schema_violation_raises_with_detail() -> None:
    bad = dict(VALID, verdict="looks_good")  # not in the enum
    with pytest.raises(LLMOutputError, match="does not match the review schema"):
        parse_llm_output(json.dumps(bad))
