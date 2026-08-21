"""Turning a stored Liffy review into a GitHub review payload (report §6, §3.1 step 12).

Everything here is a **pure function** over plain values: no client, no
session, no network. That is deliberate — the interesting behaviour in GH-2 is
the mapping and the filtering, and both are far easier to be confident about
when a test can call them directly. ``review_service`` does the I/O.
"""

import re
from dataclasses import dataclass

from app.models.review_comment import ReviewComment
from app.services.diff_parser import FileDiff
from app.services.github_service import is_line_commentable, is_span_commentable

# Liffy's verdicts map one-to-one onto GitHub's review events, and the mapping
# is still not a straight lookup — see ``resolve_event``.
_NATIVE_EVENT = {
    "approve": "APPROVE",
    "request_changes": "REQUEST_CHANGES",
}

EVENT_MODE_NATIVE = "native"
EVENT_MODE_COMMENT_ONLY = "comment_only"

# GitHub's validation bodies run long, and `reviews.post_error` is a String
# column. Truncating at the boundary keeps the useful head of the message —
# GitHub puts the offending field first.
MAX_POST_ERROR_CHARS = 1000


@dataclass(frozen=True)
class ReviewEvent:
    """A GitHub review event, and why it might not be the verdict's own."""

    event: str
    # Set when the event is *not* the direct translation of the verdict. It
    # goes into the posted body: silently posting COMMENT when the verdict was
    # request_changes misrepresents the review to the person reading it.
    downgrade_note: str | None = None


def resolve_event(verdict: str | None, *, is_own_pr: bool, mode: str) -> ReviewEvent:
    """Which GitHub event to send, and whether to explain it.

    Three reasons the answer is not simply ``_NATIVE_EVENT[verdict]``:

    **A failed review has no verdict.** ``verdict`` is NULL on failure, and a
    review with nothing to say is a ``COMMENT``.

    **GitHub returns 422 for approving or requesting changes on your own pull
    request.** Verified live against the API:

        APPROVE          -> ["Review Can not approve your own pull request"]
        REQUEST_CHANGES  -> ["Review Can not request changes on your own pull request"]

    On this project that is the *normal* case — Liffy reviews a repository
    whose PR author and token owner are usually the same person — so it is the
    common path, not an edge case.

    **``request_changes`` on somebody else's PR genuinely blocks their merge.**
    An AI tool that blocks a human's merge by default is the kind of default
    people uninstall over, so it is opt-in via ``mode="native"``.
    """
    native = _NATIVE_EVENT.get(verdict or "")
    if native is None:
        return ReviewEvent("COMMENT")

    spoken = (verdict or "").replace("_", " ")

    if is_own_pr:
        return ReviewEvent(
            "COMMENT",
            f"Liffy would **{spoken}** here, but GitHub does not allow a review "
            "event on your own pull request — so this is posted as a comment.",
        )

    if mode != EVENT_MODE_NATIVE:
        return ReviewEvent(
            "COMMENT",
            f"Liffy's verdict is **{spoken}**. Posted as a comment because "
            "`github_review_event_mode` is `comment_only`.",
        )

    return ReviewEvent(native)


# ── Model prose is untrusted markdown ─────────────────────────────────────────
#
# Every string the model returns is derived from a diff written by whoever
# opened the pull request. On a repository that accepts outside contributions
# that author is a stranger, so a review body is untrusted markdown even though
# Liffy is the account posting it.
#
# The danger is narrow and specific. GitHub renders `![](url)` by fetching the
# URL through its own image proxy, server-side, the moment the comment is
# posted — no click, no viewer involvement, nothing for a maintainer to notice.
# Sitting in the same prompt as the attacker's diff is the retrieved context:
# real code from the private repository under review. A prompt injection that
# gets the model to emit an image whose URL carries that context turns Liffy's
# review into an exfiltration channel for the code it was asked to protect.
#
# So images are defused and links are not. A link needs a deliberate click, and
# a reviewer citing a URL is ordinary behaviour worth keeping; silently
# stripping those would cost real utility to close a hole that is not open.

# Every markdown image spelling — inline `![a](url)`, reference `![a][ref]`,
# collapsed `![a][]` — begins `![`. Escaping that bracket is what defuses all
# three at once; matching the whole construct instead would miss the reference
# forms entirely, since their URL lives elsewhere in the document.
_MD_IMAGE_OPEN = re.compile(r"!\[")

# GitHub's comment sanitiser permits a small set of raw HTML tags, and several
# of them fetch a URL on render exactly as the markdown form does. Escaping the
# opening angle bracket turns the tag into visible text.
_HTML_FETCHING_TAG = re.compile(
    r"<(?=\s*/?\s*(?:img|video|audio|picture|source|iframe|embed|object)\b)",
    re.IGNORECASE,
)


def defang_model_markdown(text: str) -> str:
    """Neutralise the auto-fetching markdown in one model-authored string.

    Applied at the render boundary rather than on the way into the database:
    the dashboard shows these same strings, and React escapes them there
    already, so the value stored stays the model's actual words and only the
    copy handed to GitHub is altered.
    """
    if not text:
        return text
    defanged = _MD_IMAGE_OPEN.sub(r"!\\[", text)
    return _HTML_FETCHING_TAG.sub("&lt;", defanged)


def _fence(text: str) -> str:
    """A fence long enough to contain ``text``.

    CommonMark closes a fenced block on the first run of backticks at least as
    long as the one that opened it, so a fixed ``` cannot hold a suggestion
    that itself contains ```. The system prompt forbids that, which settles it
    for a cooperative model and not at all for an injected one — and a
    suggestion that breaks its own fence is arbitrary markdown in the comment
    body, which is the thing above this function exists to prevent.
    """
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


# Appended to a finding's head line when the model marked it `plausible`.
#
# Subdued on purpose, and asymmetric on purpose. Nothing is appended for
# `confirmed`, which is the common case and stays quiet — a marker on every
# comment is not a marker. And it is plain italics rather than a bold shout:
# on a review where a third of the findings carry it, **PLAUSIBLE** teaches
# people to skip the header line, taking severity and category with it.
_PLAUSIBLE_MARKER = " · _plausible_"


def _confidence_suffix(confidence: str | None) -> str:
    """The marker, or nothing at all.

    Null — every comment written before this column existed — reads as nothing,
    the same as `confirmed`. That is right rather than merely convenient: a row
    that was never asked the question has not answered `plausible`.
    """
    return _PLAUSIBLE_MARKER if confidence == "plausible" else ""


def _comment_body(comment: ReviewComment) -> str:
    """One Liffy comment, rendered for GitHub.

    Severity and category lead, because they are the triage signal and GitHub
    has nowhere else to put them — the dashboard shows them as badges.
    """
    head = f"**{comment.severity}** · `{comment.category}`{_confidence_suffix(comment.confidence)}"
    body = f"{head}\n\n{defang_model_markdown(comment.comment_text)}"
    if comment.failure_scenario:
        # Its own paragraph, after the finding rather than folded into it: the
        # comment says what is wrong, this says how to make it happen, and a
        # reader deciding whether to act wants them separable.
        #
        # **Defanged.** This is model prose derived from a diff somebody else
        # wrote — the same provenance as `comment_text` directly above, and the
        # one new path this milestone opens from model output to a published
        # GitHub body. `suggestion` below is the exception, not the precedent:
        # it is code inside a fence, where markdown does not render, and
        # `_fence` is what keeps it there.
        body += f"\n\n_Fails when:_ {defang_model_markdown(comment.failure_scenario)}"
    if comment.suggestion:
        # Not defanged: a suggestion is code inside a fence, where markdown does
        # not render. Holding it there is `_fence`'s job.
        fence = _fence(comment.suggestion)
        body += f"\n\n{fence}suggestion\n{comment.suggestion}\n{fence}"
    return body


def partition_comments(
    comments: list[ReviewComment], file_diffs: list[FileDiff]
) -> tuple[list[dict], list[ReviewComment]]:
    """Split comments into ``(postable_inline, unanchorable)``.

    **One invalid line 422s the entire review**, so every comment is checked
    against the parsed diff before the call rather than after the failure.

    Multi-line spans degrade rather than drop: GitHub needs both ends in the
    same hunk, and when they are not, the comment is posted as a single-line
    comment on ``line_end``. Losing the multi-line highlight is a much smaller
    loss than losing the finding.
    """
    postable: list[dict] = []
    unanchorable: list[ReviewComment] = []

    for comment in comments:
        body = _comment_body(comment)
        spans = comment.line_end > comment.line_start

        if spans and is_span_commentable(
            file_diffs, comment.file_path, comment.line_start, comment.line_end
        ):
            postable.append(
                {
                    "path": comment.file_path,
                    "start_line": comment.line_start,
                    "line": comment.line_end,
                    "side": "RIGHT",
                    "body": body,
                }
            )
        elif is_line_commentable(file_diffs, comment.file_path, comment.line_end):
            postable.append(
                {
                    "path": comment.file_path,
                    "line": comment.line_end,
                    "side": "RIGHT",
                    "body": body,
                }
            )
        else:
            unanchorable.append(comment)

    return postable, unanchorable


def _overview(
    summary: str | None,
    changes: list[str],
    files: list[tuple[str, str]],
    comment_count: int,
) -> str:
    """The part a reader meets before any finding.

    Shaped as a briefing rather than a paragraph: what this pull request does,
    then what changed where, then how much Liffy had to say about it. A wall of
    prose is skimmed; a heading, a short list and a table are read.

    Every section is optional. A model that returned only the prose summary —
    the older output shape, or a small local model that ignored half the schema
    — still produces a sensible body here rather than a page of empty headings.
    """
    parts = [
        "## Pull request overview",
        defang_model_markdown(summary) or "_Liffy produced no summary for this review._",
    ]

    if changes:
        parts.append(
            "**Changes:**\n"
            + "\n".join(f"- {defang_model_markdown(c)}" for c in changes)
        )

    if files:
        # Pipes inside a cell would break the table; a path or a sentence
        # containing one is unusual but not impossible.
        def cell(text: str) -> str:
            return defang_model_markdown(text).replace("|", r"\|")

        rows = "\n".join(f"| `{cell(path)}` | {cell(note)} |" for path, note in files)
        parts.append(
            "### Reviewed changes\n\n"
            f"Liffy read {len(files)} changed file{'' if len(files) == 1 else 's'} "
            f"and left {comment_count} comment{'' if comment_count == 1 else 's'}.\n\n"
            "| File | Description |\n| --- | --- |\n" + rows
        )
    elif comment_count:
        parts.append(
            f"Liffy left {comment_count} comment{'' if comment_count == 1 else 's'}."
        )

    return "\n\n".join(parts)


def build_review_body(
    summary: str | None,
    *,
    event: ReviewEvent,
    unanchorable: list[ReviewComment],
    supersedes_url: str | None = None,
    changes: list[str] | None = None,
    files: list[tuple[str, str]] | None = None,
    comment_count: int = 0,
) -> str:
    """The review's top-level body.

    Carries three things the inline comments cannot:

    - the overview — what the pull request does, what changed where
    - why the event is not the verdict, when it is not
    - **the findings that could not be anchored**, as a plain-text appendix.
      Dropping them silently loses real findings; a comment on a line GitHub
      will not accept is still a comment worth reading.
    """
    parts: list[str] = [
        _overview(summary, changes or [], files or [], comment_count)
    ]

    if event.downgrade_note:
        parts.append(event.downgrade_note)

    if unanchorable:
        lines = "\n".join(
            # Severity, category, confidence marker and scenario, exactly as the
            # inline body renders them — so a finding reads the same whether it
            # anchored or ended up here.
            #
            # The scenario matters *more* here, not less. These findings have no
            # diff line attached, so a reader cannot recover the trigger from the
            # code around the comment: this text is all they get. Dropping it
            # here while requiring it everywhere else would take the one enforced
            # field away from precisely the findings that need it most.
            f"- `{c.file_path}:{c.line_start}` — **{c.severity}** · `{c.category}`"
            f"{_confidence_suffix(c.confidence)} — "
            f"{defang_model_markdown(c.comment_text)}"
            + (
                # Defanged, like every other model string on this path.
                f" _Fails when:_ {defang_model_markdown(c.failure_scenario)}"
                if c.failure_scenario
                else ""
            )
            for c in unanchorable
        )
        parts.append(
            "<details>\n<summary>"
            f"{len(unanchorable)} comment(s) could not be anchored to a diff line"
            "</summary>\n\n"
            "GitHub only accepts inline comments on lines that appear in the "
            "diff, so these are reproduced here rather than dropped.\n\n"
            f"{lines}\n</details>"
        )

    if supersedes_url:
        parts.append(
            f"_Supersedes Liffy's earlier review on this pull request: {supersedes_url}_"
        )

    return "\n\n---\n\n".join(parts)


def truncate_post_error(message: str) -> str:
    """GitHub's body, cut to fit ``reviews.post_error``."""
    if len(message) <= MAX_POST_ERROR_CHARS:
        return message
    return message[: MAX_POST_ERROR_CHARS - 1] + "…"
