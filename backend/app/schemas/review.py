from enum import Enum

from pydantic import BaseModel, ConfigDict


class ReviewVerdict(str, Enum):
    approve = "approve"
    request_changes = "request_changes"
    comment = "comment"


class ReviewCategory(str, Enum):
    logic_error = "logic_error"
    security = "security"
    performance = "performance"
    architecture = "architecture"
    convention = "convention"
    improvement = "improvement"


class ReviewSeverity(str, Enum):
    critical = "critical"
    warning = "warning"
    info = "info"


class LLMReviewComment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file: str
    line_start: int
    line_end: int
    category: ReviewCategory
    severity: ReviewSeverity
    comment: str
    suggestion: str | None = None


class LLMReviewOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str
    verdict: ReviewVerdict
    comments: list[LLMReviewComment]
