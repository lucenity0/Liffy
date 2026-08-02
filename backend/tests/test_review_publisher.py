"""The mapping and filtering behind posting a review (GH-2).

No client, no session, no network — these are pure functions over plain
values, which is where the interesting behaviour in GH-2 actually lives.
"""

import pytest

from app.models.review_comment import ReviewComment
from app.services.diff_parser import parse_diff
from app.services.review_publisher import (
    EVENT_MODE_COMMENT_ONLY,
    EVENT_MODE_NATIVE,
    MAX_POST_ERROR_CHARS,
    ReviewEvent,
    build_review_body,
    partition_comments,
    resolve_event,
    truncate_post_error,
)

TWO_HUNK_DIFF = """\
diff --git a/app/main.py b/app/main.py
--- a/app/main.py
+++ b/app/main.py
@@ -1,4 +1,5 @@
 import os
+import sys

 def one():
     return 1
@@ -40,4 +41,4 @@ def two():
 def two():
-    return 1
+    return 2

"""


def _comment(
    *, path: str = "app/main.py", start: int = 2, end: int = 2,
    severity: str = "warning", category: str = "logic_error",
    text: str = "This is wrong.", suggestion: str | None = None,
) -> ReviewComment:
    return ReviewComment(
        file_path=path, line_start=start, line_end=end,
        severity=severity, category=category, comment_text=text, suggestion=suggestion,
    )


# ── verdict -> GitHub event ───────────────────────────────────────────────────


def test_verdict_none_maps_to_comment() -> None:
    """A failed review has `verdict = None` and nothing to assert."""
    assert resolve_event(None, is_own_pr=False, mode=EVENT_MODE_NATIVE).event == "COMMENT"


def test_comment_verdict_maps_to_comment_without_a_note() -> None:
    resolved = resolve_event("comment", is_own_pr=False, mode=EVENT_MODE_NATIVE)
    assert resolved.event == "COMMENT"
    assert resolved.downgrade_note is None


def test_approve_on_own_pr_downgrades_to_comment() -> None:
    """GitHub 422s an APPROVE on your own PR — verified live against the API."""
    resolved = resolve_event("approve", is_own_pr=True, mode=EVENT_MODE_NATIVE)
    assert resolved.event == "COMMENT"
    assert resolved.downgrade_note is not None


def test_request_changes_on_own_pr_downgrades_and_says_so() -> None:
    """The body must mention it.

    Silently posting COMMENT when the verdict was request_changes
    misrepresents the review to whoever reads it.
    """
    resolved = resolve_event("request_changes", is_own_pr=True, mode=EVENT_MODE_NATIVE)
    assert resolved.event == "COMMENT"
    assert "request changes" in resolved.downgrade_note
    assert "your own pull request" in resolved.downgrade_note


def test_request_changes_on_someone_elses_pr_in_native_mode() -> None:
    resolved = resolve_event("request_changes", is_own_pr=False, mode=EVENT_MODE_NATIVE)
    assert resolved.event == "REQUEST_CHANGES"
    assert resolved.downgrade_note is None


def test_approve_on_someone_elses_pr_in_native_mode() -> None:
    assert resolve_event("approve", is_own_pr=False, mode=EVENT_MODE_NATIVE).event == "APPROVE"


@pytest.mark.parametrize("verdict", ["approve", "request_changes"])
def test_comment_only_mode_never_emits_a_blocking_event(verdict: str) -> None:
    """The default. An AI tool that blocks a human's merge by default is the
    kind of default people uninstall over."""
    resolved = resolve_event(verdict, is_own_pr=False, mode=EVENT_MODE_COMMENT_ONLY)
    assert resolved.event == "COMMENT"
    assert "comment_only" in resolved.downgrade_note


def test_own_pr_takes_precedence_over_native_mode() -> None:
    """Even opted in, GitHub still refuses. The note says which reason applies."""
    resolved = resolve_event("approve", is_own_pr=True, mode=EVENT_MODE_NATIVE)
    assert "your own pull request" in resolved.downgrade_note
    assert "comment_only" not in resolved.downgrade_note


# ── comment -> inline payload ─────────────────────────────────────────────────


def test_single_line_comment_becomes_a_right_side_anchor() -> None:
    postable, unanchorable = partition_comments(
        [_comment(start=2, end=2)], parse_diff(TWO_HUNK_DIFF)
    )
    assert unanchorable == []
    assert postable[0]["path"] == "app/main.py"
    assert postable[0]["line"] == 2
    assert postable[0]["side"] == "RIGHT"
    assert "start_line" not in postable[0]


def test_multiline_span_within_one_hunk_keeps_both_ends() -> None:
    postable, _ = partition_comments(
        [_comment(start=1, end=3)], parse_diff(TWO_HUNK_DIFF)
    )
    assert postable[0]["start_line"] == 1
    assert postable[0]["line"] == 3


def test_span_across_two_hunks_degrades_to_a_single_line() -> None:
    """Degrades rather than drops.

    Losing the multi-line highlight is a far smaller loss than losing the
    finding — and sending it as-is would 422 the whole review.
    """
    postable, unanchorable = partition_comments(
        [_comment(start=2, end=42)], parse_diff(TWO_HUNK_DIFF)
    )
    assert unanchorable == []
    assert "start_line" not in postable[0]
    assert postable[0]["line"] == 42


def test_comment_outside_every_hunk_is_unanchorable() -> None:
    postable, unanchorable = partition_comments(
        [_comment(start=25, end=25)], parse_diff(TWO_HUNK_DIFF)
    )
    assert postable == []
    assert len(unanchorable) == 1


def test_comment_on_a_file_not_in_the_diff_is_unanchorable() -> None:
    postable, unanchorable = partition_comments(
        [_comment(path="other.py")], parse_diff(TWO_HUNK_DIFF)
    )
    assert postable == []
    assert len(unanchorable) == 1


def test_deleted_file_comments_are_not_sent_inline() -> None:
    """A deleted file has no RIGHT side for a comment to point at."""
    raw = (
        "diff --git a/gone.py b/gone.py\n"
        "deleted file mode 100644\n"
        "--- a/gone.py\n"
        "+++ /dev/null\n"
        "@@ -1,2 +0,0 @@\n"
        "-a\n"
        "-b\n"
    )
    postable, unanchorable = partition_comments(
        [_comment(path="gone.py", start=1, end=1)], parse_diff(raw)
    )
    assert postable == []
    assert len(unanchorable) == 1


def test_comment_body_carries_severity_and_category() -> None:
    """GitHub has nowhere else to put them; the dashboard shows badges."""
    postable, _ = partition_comments(
        [_comment(severity="critical", category="security")], parse_diff(TWO_HUNK_DIFF)
    )
    assert "critical" in postable[0]["body"]
    assert "security" in postable[0]["body"]


def test_a_suggestion_becomes_a_github_suggestion_block() -> None:
    postable, _ = partition_comments(
        [_comment(suggestion="return 2")], parse_diff(TWO_HUNK_DIFF)
    )
    assert "```suggestion\nreturn 2\n```" in postable[0]["body"]


def test_no_comments_is_not_an_error() -> None:
    assert partition_comments([], parse_diff(TWO_HUNK_DIFF)) == ([], [])


# ── the review body ───────────────────────────────────────────────────────────


def test_body_carries_the_summary() -> None:
    body = build_review_body(
        "Looks fine.", event=resolve_event("comment", is_own_pr=False, mode="native"),
        unanchorable=[],
    )
    assert "Looks fine." in body


def test_unanchorable_comments_appear_in_the_body() -> None:
    """Dropping them silently loses real findings."""
    orphan = _comment(start=25, end=25, text="Unreachable branch.")
    body = build_review_body(
        "Summary.", event=resolve_event("comment", is_own_pr=False, mode="native"),
        unanchorable=[orphan],
    )
    assert "Unreachable branch." in body
    assert "app/main.py:25" in body


def test_body_explains_a_downgrade() -> None:
    event = resolve_event("request_changes", is_own_pr=True, mode="native")
    body = build_review_body("Summary.", event=event, unanchorable=[])
    assert "your own pull request" in body


def test_body_handles_a_missing_summary() -> None:
    body = build_review_body(
        None, event=resolve_event(None, is_own_pr=False, mode="native"), unanchorable=[]
    )
    assert body  # not empty, and not the string "None"
    assert "None" not in body


def test_body_names_the_review_it_supersedes() -> None:
    body = build_review_body(
        "Summary.",
        event=resolve_event("comment", is_own_pr=False, mode="native"),
        unanchorable=[],
        supersedes_url="https://github.com/o/r/pull/1#pullrequestreview-1",
    )
    assert "pullrequestreview-1" in body
    assert "supersedes" in body.lower()


# ── post_error truncation ─────────────────────────────────────────────────────


def test_short_errors_pass_through_unchanged() -> None:
    assert truncate_post_error("boom") == "boom"


def test_long_errors_are_truncated_to_fit_the_column() -> None:
    """`post_error` is String(1024) and GitHub's validation bodies run long."""
    truncated = truncate_post_error("x" * 5000)
    assert len(truncated) == MAX_POST_ERROR_CHARS
    assert truncated.endswith("…")


# ── The overview ──────────────────────────────────────────────────────────────


def test_the_body_opens_with_a_briefing_not_a_paragraph() -> None:
    """What a reader meets before any finding.

    A wall of prose gets skimmed. A heading, a short list of what the pull
    request does, and a table of what changed where gets read — and it carries
    the review even when there are no findings at all.
    """
    body = build_review_body(
        "Adds a lexical help search over a shipped markdown corpus.",
        event=ReviewEvent("COMMENT", None),
        unanchorable=[],
        changes=["Adds a BM25 index.", "Adds a /help page."],
        files=[
            ("backend/app/services/help_service.py", "The ranking core."),
            ("frontend/src/pages/Help.tsx", "The two-pane page."),
        ],
        comment_count=3,
    )

    assert body.startswith("## Pull request overview")
    assert "Adds a lexical help search" in body
    assert "- Adds a BM25 index." in body
    assert "| File | Description |" in body
    assert "| `backend/app/services/help_service.py` | The ranking core. |" in body
    assert "read 2 changed files and left 3 comments" in body


def test_the_body_survives_a_model_that_only_returned_prose() -> None:
    """The older three-field output, and any small model that ignores half the
    schema, must still produce a sensible body — not a page of empty headings."""
    body = build_review_body(
        "Nothing worth flagging.",
        event=ReviewEvent("COMMENT", None),
        unanchorable=[],
    )

    assert "## Pull request overview" in body
    assert "Nothing worth flagging." in body
    assert "Changes:" not in body
    assert "| File |" not in body


def test_singular_and_plural_read_correctly() -> None:
    body = build_review_body(
        "One small change.",
        event=ReviewEvent("COMMENT", None),
        unanchorable=[],
        files=[("a.py", "Renames a helper.")],
        comment_count=1,
    )

    assert "read 1 changed file and left 1 comment." in body


def test_a_pipe_in_a_cell_cannot_break_the_table() -> None:
    """Unusual, not impossible — and a broken table takes the whole overview
    down with it."""
    body = build_review_body(
        "A change.",
        event=ReviewEvent("COMMENT", None),
        unanchorable=[],
        files=[("a|b.py", "Handles a | b cases.")],
        comment_count=0,
    )

    table_row = [line for line in body.splitlines() if line.startswith("| `")][0]
    # Four unescaped pipes: the row's own delimiters, and no more.
    assert len([c for i, c in enumerate(table_row) if c == "|" and table_row[i - 1] != "\\"]) == 3
