"""LLM output validation (report §7.2 step 07, §7.3).

The model is instructed to return bare JSON; in practice models sometimes wrap
it in markdown fences or prose, so we extract the outermost JSON object before
validating against the Pydantic schema.
"""

import json

from pydantic import ValidationError

from app.schemas.review import LLMReviewOutput


class LLMOutputError(ValueError):
    """Raised when the model's output cannot be parsed into LLMReviewOutput.

    ``str(err)`` is fed back to the model on retry, so keep it descriptive.
    """


def _extract_json_object(raw: str) -> str:
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end <= start:
        raise LLMOutputError("No JSON object found in model output.")
    return raw[start : end + 1]


def parse_llm_output(raw: str) -> LLMReviewOutput:
    candidate = _extract_json_object(raw)
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise LLMOutputError(f"Output is not valid JSON: {exc}") from exc
    try:
        return LLMReviewOutput.model_validate(data)
    except ValidationError as exc:
        raise LLMOutputError(f"JSON does not match the review schema: {exc}") from exc
