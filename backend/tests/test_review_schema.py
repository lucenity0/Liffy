import pytest
from pydantic import ValidationError

from app.schemas.review import LLMReviewOutput, ReviewCommentOut


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


# ── ReviewCommentOut carries the two new columns (REV-QUAL-3) ────────────────


class _Row:
    """The shape SQLAlchemy hands ``from_attributes`` — attributes, no dict.

    A plain stub rather than a real ORM row: what is being pinned is that the
    response model *reads* both columns, and a stub fails just as loudly as a
    table would if the field is missing from the schema.
    """

    def __init__(self, **kwargs) -> None:
        self.__dict__.update(kwargs)


def _row(**overrides) -> _Row:
    import datetime
    import uuid as _uuid

    base = {
        "id": _uuid.uuid4(),
        "file_path": "backend/app/main.py",
        "line_start": 1,
        "line_end": 2,
        "category": "security",
        "severity": "warning",
        "comment_text": "Validate input.",
        "suggestion": None,
        "created_at": datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
        "confidence": None,
        "failure_scenario": None,
    }
    base.update(overrides)
    return _Row(**base)


def test_comment_out_validates_a_row_with_both_columns_null() -> None:
    """The majority case: every comment written before this milestone."""
    parsed = ReviewCommentOut.model_validate(_row())
    assert parsed.confidence is None
    assert parsed.failure_scenario is None


def test_comment_out_carries_both_columns_when_set() -> None:
    parsed = ReviewCommentOut.model_validate(
        _row(
            confidence="plausible",
            failure_scenario="With an empty list, the loop reads index -1.",
        )
    )
    assert parsed.confidence == "plausible"
    assert parsed.failure_scenario == "With an empty list, the loop reads index -1."
