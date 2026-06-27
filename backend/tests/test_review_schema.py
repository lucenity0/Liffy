import pytest
from pydantic import ValidationError

from app.schemas.review import LLMReviewOutput


def test_review_schema_accepts_valid_payload() -> None:
    payload = {
        "summary": "Looks mostly good.",
        "verdict": "comment",
        "comments": [
            {
                "file": "backend/app/main.py",
                "line_start": 1,
                "line_end": 2,
                "category": "security",
                "severity": "warning",
                "comment": "Validate input.",
                "suggestion": None,
            }
        ],
    }
    parsed = LLMReviewOutput.model_validate(payload)
    assert parsed.verdict.value == "comment"


@pytest.mark.parametrize("field,value", [("category", "typo"), ("severity", "urgent")])
def test_review_schema_rejects_unknown_enum_values(field: str, value: str) -> None:
    payload = {
        "summary": "Looks mostly good.",
        "verdict": "comment",
        "comments": [
            {
                "file": "backend/app/main.py",
                "line_start": 1,
                "line_end": 2,
                "category": "security",
                "severity": "warning",
                "comment": "Validate input.",
                "suggestion": None,
            }
        ],
    }
    payload["comments"][0][field] = value

    with pytest.raises(ValidationError):
        LLMReviewOutput.model_validate(payload)
