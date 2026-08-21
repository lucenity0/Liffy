import pytest
from pydantic import ValidationError

from app.schemas.review import LLMReviewOutput, ReviewCommentOut, ReviewConfidence


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
                "failure_scenario": "A request with `?q=';DROP` reaches the query unescaped.",
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
                "failure_scenario": "A request with `?q=';DROP` reaches the query unescaped.",
            }
        ],
    }
    payload["comments"][0][field] = value

    with pytest.raises(ValidationError):
        LLMReviewOutput.model_validate(payload)


# ── failure_scenario is required (REV-QUAL-4) ────────────────────────────────


def test_review_schema_rejects_a_comment_without_a_failure_scenario() -> None:
    """Required, and being required is the whole mechanism.

    An optional field gets omitted and the prompt's discard rule stops biting —
    what is left is the same polite request for specificity the prompt already
    made and the model already satisfied by sounding specific. This assertion
    is what makes the rule enforced rather than requested, on every provider.
    """
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

    with pytest.raises(ValidationError) as exc:
        LLMReviewOutput.model_validate(payload)

    # The message goes back to the model verbatim on retry, so it has to name
    # the field. "1 validation error" alone tells it nothing to act on.
    assert "failure_scenario" in str(exc.value)


def test_a_comment_with_no_findings_needs_no_scenario() -> None:
    """The empty review still validates — the field is per comment, not per review."""
    parsed = LLMReviewOutput.model_validate(
        {"summary": "Nothing to flag.", "verdict": "approve", "comments": []}
    )
    assert parsed.comments == []


# ── confidence is defaulted, not required (REV-QUAL-5) ───────────────────────


def _payload(**comment_overrides) -> dict:
    comment = {
        "file": "backend/app/main.py",
        "line_start": 1,
        "line_end": 2,
        "category": "security",
        "severity": "warning",
        "comment": "Validate input.",
        "suggestion": None,
        "failure_scenario": "A request with a quote in `q` reaches the query unescaped.",
    }
    comment.update(comment_overrides)
    return {"summary": "s", "verdict": "comment", "comments": [comment]}


def test_confidence_defaults_to_confirmed_when_omitted() -> None:
    """Defaulted, unlike `failure_scenario`, and the asymmetry is the design.

    A response in the older shape still validates rather than burning the retry
    budget: confidence degrades presentation, `failure_scenario` is the review.
    The default leans to `confirmed` — the less conservative option — because
    the alternative marks every older-shaped response as uncertain, which is a
    claim about the model the response never made.
    """
    parsed = LLMReviewOutput.model_validate(_payload())
    assert parsed.comments[0].confidence is ReviewConfidence.confirmed


def test_confidence_accepts_plausible() -> None:
    parsed = LLMReviewOutput.model_validate(_payload(confidence="plausible"))
    assert parsed.comments[0].confidence is ReviewConfidence.plausible


def test_confidence_rejects_anything_else() -> None:
    """An enum, so nothing arbitrary reaches the column.

    Validity is enforced here. *Accuracy* is not, anywhere, and deliberately so
    — nothing checks that a `confirmed` finding really is one, and a checker
    would only be the model marking its own homework twice.
    """
    with pytest.raises(ValidationError):
        LLMReviewOutput.model_validate(_payload(confidence="pretty sure"))


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
