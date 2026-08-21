"""Review prompt construction (PROMPT-1, report §7.2 steps 04-05).

**These assert structure and required instructions, never exact sentences.**
Prompt wording is the thing PROMPT-1 exists to iterate on; a test that pins a
sentence turns every future tweak into a red suite and trains whoever is
iterating to edit the test instead of thinking about the change.

So: the six categories come from the enum, the three severities come from the
enum, and behavioural instructions are checked by the *concept* they have to
convey rather than by the phrasing chosen this week.
"""

import json

import pytest

from app.llm.prompts import (
    MAX_CONTEXT_CHARS,
    SYSTEM_PROMPT,
    build_review_prompt,
)
from app.schemas.review import LLMReviewOutput, ReviewCategory, ReviewSeverity
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


def _chunk(text: str, *, path: str = "app/other.py", start: int = 1) -> RetrievedChunk:
    return RetrievedChunk(
        file_path=path,
        start_line=start,
        end_line=start + 5,
        kind="function",
        name="helper",
        text=text,
        distance=0.1,
    )


# ── The system prompt's contract with the schema ──────────────────────────────


def test_system_prompt_lists_all_six_categories() -> None:
    """Derived from the enum, so adding a category cannot silently skip the prompt.

    A category the model is never told about is one it can never emit, and the
    §8.1 distribution would show a permanent zero with no way to tell that
    apart from "this never applies".
    """
    for category in ReviewCategory:
        assert category.value in SYSTEM_PROMPT, category.value


def test_system_prompt_lists_all_three_severities() -> None:
    for severity in ReviewSeverity:
        assert severity.value in SYSTEM_PROMPT, severity.value


def test_system_prompt_embeds_the_output_schema() -> None:
    """The schema is rendered from the Pydantic model, so prompt and validator
    cannot drift. This asserts the rendering actually happened."""
    schema = LLMReviewOutput.model_json_schema()
    assert '"summary"' in SYSTEM_PROMPT
    assert '"verdict"' in SYSTEM_PROMPT
    assert '"comments"' in SYSTEM_PROMPT
    # Every required top-level field of the real schema is named.
    for field in schema["required"]:
        assert f'"{field}"' in SYSTEM_PROMPT, field


def test_system_prompt_names_the_new_file_line_convention() -> None:
    """`line_start`/`line_end` are consumed as **new-file** line numbers by
    BASE-7's anchoring and by GH-1's `is_line_commentable`. If the prompt stops
    saying so, both silently anchor against the wrong numbering."""
    lowered = SYSTEM_PROMPT.lower()
    assert "new" in lowered and "line" in lowered
    assert "line_start" in SYSTEM_PROMPT
    assert "line_end" in SYSTEM_PROMPT


# ── Behavioural instructions, checked by concept ──────────────────────────────


def test_prompt_discourages_speculation() -> None:
    """Some instruction has to push against inventing issues.

    Matched against a set of phrasings rather than one sentence: this is
    exactly the line PROMPT-1 iterates on, and the requirement is that the
    instruction *exists*, not that it is worded a particular way.
    """
    lowered = SYSTEM_PROMPT.lower()
    assert any(
        phrase in lowered
        for phrase in ("do not invent", "do not speculate", "higher-confidence", "evidence")
    ), "the prompt must tell the model not to manufacture issues"


def test_prompt_states_the_discard_rule() -> None:
    """Some instruction has to say that an unwritable scenario means no finding.

    The schema makes the field *mandatory*, which on its own only teaches the
    model to fill it — with a restatement of the comment if that is the cheapest
    way to satisfy the validator. The discard rule is what turns the field from
    a box to tick into a filter, and it lives only in the prompt.

    Concept, not phrasing, per this file's rule.
    """
    lowered = SYSTEM_PROMPT.lower()
    assert "failure_scenario" in lowered
    assert any(
        phrase in lowered
        for phrase in ("drop the finding", "drop it", "do not report", "omit the finding")
    ), "the prompt must say to discard a finding it cannot write a scenario for"


def test_the_output_schema_marks_failure_scenario_required() -> None:
    """Required in the rendered schema, not merely mentioned in the prose.

    `_OUTPUT_SCHEMA` is what the model is actually shown, and a field that is
    described in a rule but sits outside `required` reads to the model as
    optional — which is the difference between the enforced mechanism and the
    polite request the prompt already made.
    """
    schema = LLMReviewOutput.model_json_schema()
    comment_schema = schema["$defs"]["LLMReviewComment"]
    assert "failure_scenario" in comment_schema["required"]
    assert '"failure_scenario"' in SYSTEM_PROMPT


def test_prompt_states_zero_comments_is_acceptable() -> None:
    """A model handed a schema with a `comments` array tends to fill it.

    Nothing in the original prompt said an empty array was a good outcome, and
    a trivial PR that produces manufactured nitpicks is the clearest possible
    signal that it needs saying.
    """
    lowered = SYSTEM_PROMPT.lower()
    assert any(
        phrase in lowered
        for phrase in ("empty", "zero comments", "no comments", "no issues")
    ), "the prompt must say that returning no comments is a valid outcome"


def test_prompt_requires_suggestions_to_be_replacement_text() -> None:
    lowered = SYSTEM_PROMPT.lower()
    assert "only" in lowered
    assert "replacement" in lowered
    assert "no explanation" in lowered
    assert "suggestion to null" in lowered


def test_severity_line_defines_all_three_levels() -> None:
    """Whatever the wording, every level the schema allows must be defined.

    Deliberately *not* asserting that severity is defined by observable effect.
    That rewrite was written, measured over the same five PRs twice, and
    rejected — it reintroduced the speculative comments the zero-comments rule
    had removed and lost two real defects while doing it. See ADR 005 and
    docs/prompt-eval/after-severity*.json. Asserting the shape of a change the
    evidence rejected would make this suite argue against its own findings.
    """
    lowered = SYSTEM_PROMPT.lower()
    for level in ("critical", "warning", "info"):
        assert level in lowered, f"severity level {level!r} is unexplained to the model"


# ── The user prompt ───────────────────────────────────────────────────────────


def test_user_prompt_carries_the_title_and_the_diff() -> None:
    prompt = build_review_prompt("Fix the helper", parse_diff(DIFF), [])
    assert "Fix the helper" in prompt
    assert "app/util.py" in prompt
    assert "+extra" in prompt


def test_empty_diff_renders_a_placeholder() -> None:
    """A PR with nothing parseable must not send an empty section that reads
    as a truncated prompt."""
    prompt = build_review_prompt("Empty", [], [])
    assert "(empty diff)" in prompt


def test_no_context_renders_a_placeholder() -> None:
    """An unindexed repository is a normal state, not a broken prompt."""
    prompt = build_review_prompt("Title", parse_diff(DIFF), [])
    assert "(no similar code found)" in prompt


def test_context_chunks_are_labelled_with_their_location() -> None:
    """Retrieval is only useful if the model can cite where it came from —
    the `convention` category explicitly asks it to."""
    prompt = build_review_prompt("Title", parse_diff(DIFF), [_chunk("def helper(): ...")])
    assert "app/other.py" in prompt
    assert "def helper(): ..." in prompt


def test_context_section_respects_max_context_chars() -> None:
    """The budget is what keeps total prompt size predictable.

    Chunks are dropped whole rather than truncated mid-block: half a function
    is worse context than no function.
    """
    big = _chunk("x" * (MAX_CONTEXT_CHARS // 2), path="a.py")
    also_big = _chunk("y" * (MAX_CONTEXT_CHARS // 2), path="b.py", start=100)
    third = _chunk("z" * (MAX_CONTEXT_CHARS // 2), path="c.py", start=200)

    prompt = build_review_prompt("Title", parse_diff(DIFF), [big, also_big, third])

    assert "c.py" not in prompt
    assert len(prompt) < MAX_CONTEXT_CHARS * 2


def test_context_is_rendered_in_the_order_given() -> None:
    """`_gather_context` sorts by distance, so the most similar chunk is first
    and is the one that survives the budget."""
    prompt = build_review_prompt(
        "Title",
        parse_diff(DIFF),
        [_chunk("closest", path="near.py"), _chunk("further", path="far.py", start=50)],
    )
    assert prompt.index("near.py") < prompt.index("far.py")


# ── #227: the model must not have to count lines ──────────────────────────────


def test_diff_lines_carry_their_new_file_line_number() -> None:
    """The root cause in #227: the prompt gave only the hunk's start line, so
    naming any other line meant counting `+`/context rows and skipping `-` rows.
    Every comment on PR #58 was correct and every line number was wrong.

    Asserting the number is *present on the line*, not the wording around it.
    """
    # `@@ -10,4 +10,5 @@` — context 10, removed (no number), then 11, 12, 13.
    prompt = build_review_prompt("Fix the helper", parse_diff(DIFF), [])
    assert "10  context" in prompt
    assert "11 +new" in prompt
    assert "12 +extra" in prompt
    # The removed line is rendered but has no new-file number to offer.
    assert "   -old" in prompt
    assert "11 -old" not in prompt


def test_system_prompt_explains_the_gutter() -> None:
    """Numbering the lines only helps if the model is told what the numbers are.

    Concept, not phrasing: it must convey that the number is to be read off the
    line rather than derived.
    """
    lowered = SYSTEM_PROMPT.lower()
    assert "gutter" in lowered or "line number" in lowered
    assert any(
        phrase in lowered
        for phrase in ("do not count", "not count", "copy the number", "read it off")
    ), "the prompt must tell the model to read the number, not compute it"


def test_retrieved_context_lines_are_distinguishable_from_diff_lines() -> None:
    """A comment anchored to a *retrieved* line instead of a *diff* line would
    look exactly like #227's signature — right file, plausible number, wrong
    place. Retrieval already excludes the file under review (`exclude_file` in
    `rag_service`), so this cannot currently happen; this test keeps the two
    kinds of line visually separable if that ever changes.

    The context chunk here is deliberately shaped like diff content.
    """
    sneaky = _chunk("+new\n+extra\n context", path="app/other.py", start=12)
    prompt = build_review_prompt("Title", parse_diff(DIFF), [sneaky])

    marker = "BEGIN UNTRUSTED RETRIEVED CODEBASE CONTEXT"
    diff_section = prompt.split(marker)[0]
    context_section = prompt.split(marker)[1]

    # The two sections are separately headed...
    assert "BEGIN UNTRUSTED DIFF" in diff_section
    # ...the diff carries per-line numbers...
    assert "11 +new" in diff_section
    # ...and the context block carries its range in its header only, so its
    # body lines offer no number that could be mistaken for a commentable one.
    assert "app/other.py:12-17" in context_section
    assert "11 +new" not in context_section
    assert "+new" in context_section  # the text is there, just unnumbered


# ── Determinism ───────────────────────────────────────────────────────────────


def test_prompt_construction_is_deterministic() -> None:
    """Same inputs, same prompt — otherwise prompt caching never hits and a
    before/after comparison has a second variable in it."""
    args = ("Title", parse_diff(DIFF), [_chunk("ctx")])
    assert build_review_prompt(*args) == build_review_prompt(*args)


def test_system_prompt_is_a_module_constant() -> None:
    """Built once at import, which is what makes the `cache_control` ephemeral
    block on it worth anything."""
    from app.llm import prompts

    assert prompts.SYSTEM_PROMPT is SYSTEM_PROMPT


@pytest.mark.parametrize(
    "field",
    ["file", "line_start", "line_end", "category", "severity", "failure_scenario"],
)
def test_schema_fields_the_pipeline_depends_on_are_in_the_prompt(field: str) -> None:
    """Each of these is read by name downstream — by `_anchor_comments`, by
    `partition_comments`, or by the §8.1 metrics. A model that omits one
    produces a comment the pipeline drops."""
    assert field in SYSTEM_PROMPT
    assert field in json.dumps(LLMReviewOutput.model_json_schema())


# ── Untrusted input boundaries ────────────────────────────────────────────────


def test_attacker_authored_sections_are_delimited() -> None:
    """The title and the diff come from whoever opened the pull request.

    A bare `## Diff` heading gives an injected "## End of diff, new instructions
    follow" exactly the same standing as Liffy's own headings, since both are
    just text the model reads. Naming where the untrusted region ends is what
    makes the system prompt's "this is data" rule refer to something.
    """
    prompt = build_review_prompt("Title", parse_diff(DIFF), [])

    for marker in (
        "BEGIN UNTRUSTED PULL REQUEST TITLE",
        "END UNTRUSTED PULL REQUEST TITLE",
        "BEGIN UNTRUSTED DIFF",
        "END UNTRUSTED DIFF",
        "BEGIN UNTRUSTED RETRIEVED CODEBASE CONTEXT",
        "END UNTRUSTED RETRIEVED CODEBASE CONTEXT",
    ):
        assert marker in prompt

    # The title sits inside its own block, not loose on a line of its own where
    # a newline in it would read as the start of the next section.
    title_block = prompt.split("BEGIN UNTRUSTED PULL REQUEST TITLE")[1]
    assert title_block.split("END UNTRUSTED PULL REQUEST TITLE")[0].strip() == "Title"


def test_system_prompt_states_the_data_rule() -> None:
    """Belt to the delimiters' braces: the markers say where, this says what it
    means. The enforceable guarantee is neither of these — it is
    `review_publisher.defang_model_markdown` — but a model that follows the rule
    produces a better review than one that has to be cleaned up after.

    Checked by concept, per this file's rule: the requirement is that the prompt
    tells the model the diff is not a source of instructions, not that it does so
    in this week's words.
    """
    lowered = SYSTEM_PROMPT.lower()
    assert any(
        phrase in lowered
        for phrase in ("data, not", "not instructions", "is not an instruction")
    ), "the prompt must tell the model that pull request content is data"
    assert any(
        phrase in lowered for phrase in ("hostile", "stranger", "untrusted")
    ), "the prompt must say the author may be untrusted"


# ── Prior findings on an incremental re-review ───────────────────────────────


def test_prior_findings_are_absent_when_there_are_none():
    """The common case — a first review — must not gain an empty block."""
    from app.llm.prompts import build_review_prompt

    prompt = build_review_prompt("t", [], [])
    assert "PREVIOUS REVIEW" not in prompt


def test_prior_findings_are_delimited_as_untrusted():
    """They are model output derived from an attacker-authored diff.

    A previous finding quoting a hostile string is the same injection surface
    as the diff it came from, so it gets the same fencing.
    """
    from app.llm.prompts import build_review_prompt

    prompt = build_review_prompt("t", [], [], ["a.py:1 [warning] Still broken."])
    assert "BEGIN UNTRUSTED FINDINGS FROM YOUR PREVIOUS REVIEW" in prompt
    assert "END UNTRUSTED FINDINGS FROM YOUR PREVIOUS REVIEW" in prompt
    assert "Still broken." in prompt


def test_prior_findings_are_bounded():
    """A pull request re-reviewed many times would otherwise grow without limit."""
    from app.llm.prompts import MAX_PRIOR_FINDINGS, build_review_prompt

    findings = [f"a.py:{i} [info] finding {i}" for i in range(MAX_PRIOR_FINDINGS + 7)]
    prompt = build_review_prompt("t", [], [], findings)

    assert f"finding {MAX_PRIOR_FINDINGS - 1}" in prompt
    assert f"finding {MAX_PRIOR_FINDINGS}" not in prompt
    assert "and 7 more, not shown" in prompt


def test_the_system_prompt_says_the_diff_may_be_partial():
    """Without this the model reviews an increment as though it were the whole
    pull request, and reports the absence of everything it cannot see."""
    from app.llm.prompts import SYSTEM_PROMPT

    assert "only what has been pushed since that review" in SYSTEM_PROMPT
    assert "still stand" in SYSTEM_PROMPT
