"""Review prompt construction (report §7.2 steps 04-05).

The JSON schema is rendered from the Pydantic model so prompt and validator
can never drift apart.
"""

import json

from app.schemas.review import LLMReviewOutput
from app.services.diff_parser import FileDiff, chunk_text
from app.services.rag_service import RetrievedChunk

# Keep retrieved context bounded so total prompt size stays predictable.
MAX_CONTEXT_CHARS = 12_000

_OUTPUT_SCHEMA = json.dumps(LLMReviewOutput.model_json_schema(), indent=2)

SYSTEM_PROMPT = f"""\
You are a senior software engineer performing a thorough code review of a pull request.

You are given:
1. The diff of the pull request, split into hunks. Each hunk starts with a header
   line of the form `# <file path> lines <start>-<end>` giving the file path and
   the line numbers in the NEW version of the file.
2. Retrieved context: functions and classes from elsewhere in the same codebase
   that are semantically similar to the changed code. Use them to spot duplicated
   logic, violated conventions, and broken assumptions in dependent code.

Review for:
- logic_error: incorrect logic that will cause wrong or undefined behaviour
- security: vulnerability, unsafe pattern, or unvalidated input
- performance: unnecessary complexity, N+1 queries, or algorithmically suboptimal code
- architecture: design decision introducing coupling or missing abstraction
- convention: violation of patterns established elsewhere in the codebase (cite the retrieved context)
- improvement: non-critical suggestion for clarity or maintainability

Severity: critical = must fix before merge; warning = should fix; info = optional.

Rules:
- Only comment on lines that appear in the diff. For line_start/line_end, use the
  NEW-file line numbers from the hunk headers.
- Be specific and actionable; reference identifiers from the code, not generalities.
- Do not invent issues. Fewer, higher-confidence comments beat exhaustive nitpicks.
- suggestion, when present, is a concrete replacement snippet or fix description.
- Respond with ONLY a valid JSON object matching this schema — no markdown fences,
  no prose before or after:

{_OUTPUT_SCHEMA}
"""


def _render_context(context_chunks: list[RetrievedChunk]) -> str:
    blocks: list[str] = []
    used = 0
    for chunk in context_chunks:
        label = f" {chunk.kind} {chunk.name}".rstrip()
        block = f"--- {chunk.file_path}:{chunk.start_line}-{chunk.end_line}{label} ---\n{chunk.text}"
        if used + len(block) > MAX_CONTEXT_CHARS:
            break
        blocks.append(block)
        used += len(block)
    return "\n\n".join(blocks)


def build_review_prompt(
    pr_title: str,
    file_diffs: list[FileDiff],
    context_chunks: list[RetrievedChunk],
) -> str:
    diff_blocks = [block for fd in file_diffs for block in chunk_text(fd)]
    diff_section = "\n\n".join(diff_blocks) if diff_blocks else "(empty diff)"
    context_section = _render_context(context_chunks) or "(no similar code found)"
    return f"""\
Pull request: {pr_title}

## Diff
{diff_section}

## Retrieved codebase context
{context_section}

Produce your review as JSON now."""
