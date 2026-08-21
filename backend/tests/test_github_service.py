import json
from datetime import datetime, timezone

import httpx
import pytest

from app.config import settings
from app.services.diff_parser import parse_diff
from app.services.github_service import (
    GITHUB_API_BASE,
    _is_indexable,
    GitHubAuthError,
    GitHubClient,
    GitHubError,
    GitHubRateLimitError,
    GitHubWriteError,
    PullRequestMeta,
    RepositoryMeta,
    get_github_token,
    is_line_commentable,
    is_span_commentable,
)


def _client(handler) -> GitHubClient:
    transport = httpx.MockTransport(handler)
    http = httpx.Client(base_url="https://api.github.com", transport=transport)
    return GitHubClient(token="test-token", client=http)


def test_get_github_token_prefers_argument() -> None:
    assert get_github_token("abc") == "abc"


def test_get_github_token_falls_back_to_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "github_token", "env-pat")
    assert get_github_token() == "env-pat"


def test_get_github_token_raises_without_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "github_token", "")
    with pytest.raises(GitHubAuthError):
        get_github_token()


def test_get_pull_request_parses_metadata() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer test-token"
        assert request.url.path == "/repos/octo/hello/pulls/7"
        return httpx.Response(
            200,
            json={
                "number": 7,
                "title": "Add feature",
                "state": "open",
                "user": {"login": "octocat"},
                "base": {"ref": "main"},
                "head": {"ref": "feature", "sha": "abc123"},
            },
        )

    pr = _client(handler).get_pull_request("octo", "hello", 7)
    assert pr == PullRequestMeta(
        number=7,
        title="Add feature",
        author="octocat",
        base_branch="main",
        head_branch="feature",
        head_sha="abc123",
        state="open",
    )


def test_get_pull_request_reads_merged_at() -> None:
    """GitHub returns it; nothing was reading it.

    `state` is `open` or `closed` and says nothing about *how* it closed, so
    for as long as this field went unread a merged pull request and an
    abandoned one were the same row.
    """
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "number": 7,
                "title": "Add feature",
                "state": "closed",
                "merged": True,
                "merged_at": "2026-08-21T18:39:30Z",
                "user": {"login": "octocat"},
                "base": {"ref": "main"},
                "head": {"ref": "feature", "sha": "abc123"},
            },
        )

    pr = _client(handler).get_pull_request("octo", "hello", 7)
    assert pr.state == "closed"
    assert pr.merged_at == "2026-08-21T18:39:30Z"


def test_get_pull_request_merged_at_is_none_when_absent() -> None:
    """An open pull request has no merge date, and the absent key must not
    become an empty string — `parse_github_timestamp` treats both as None, but
    a falsy sentinel in the dataclass would read as "merged at the epoch" to
    anything that checked truthiness differently."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "number": 7,
                "title": "Add feature",
                "state": "open",
                "user": {"login": "octocat"},
                "base": {"ref": "main"},
                "head": {"ref": "feature", "sha": "abc123"},
            },
        )

    assert _client(handler).get_pull_request("octo", "hello", 7).merged_at is None


def test_list_pull_requests_reads_merged_at() -> None:
    """The list endpoint returns the same field, and the picker path has to
    carry it too — otherwise reviewing a PR chosen from the list would write a
    null over a merge date the single-PR path would have captured."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                {
                    "number": 7,
                    "title": "Add feature",
                    "state": "closed",
                    "merged_at": "2026-08-21T18:39:30Z",
                    "user": {"login": "octocat"},
                    "base": {"ref": "main"},
                    "head": {"ref": "feature", "sha": "abc123"},
                },
                {
                    "number": 8,
                    "title": "Abandoned",
                    "state": "closed",
                    "merged_at": None,
                    "user": {"login": "octocat"},
                    "base": {"ref": "main"},
                    "head": {"ref": "dead", "sha": "def456"},
                },
            ],
        )

    prs = _client(handler).list_pull_requests("octo", "hello", state="all")
    assert prs[0].merged_at == "2026-08-21T18:39:30Z"
    assert prs[1].merged_at is None


def test_parse_github_timestamp_handles_the_z_suffix() -> None:
    """`Z` is not something `fromisoformat` accepted before 3.11, and the
    columns this feeds are `timezone=True`. A naive datetime stored there reads
    back as local, which on a merge date means the merge appearing to happen
    hours away from when it did."""
    from datetime import timezone as tz

    from app.services.github_service import parse_github_timestamp

    parsed = parse_github_timestamp("2026-08-21T18:39:30Z")
    assert parsed is not None
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == tz.utc.utcoffset(None)


def test_parse_github_timestamp_returns_none_rather_than_raising() -> None:
    """A malformed timestamp should cost one merge date, not the whole sweep
    it arrived in."""
    from app.services.github_service import parse_github_timestamp

    assert parse_github_timestamp("not-a-timestamp") is None
    assert parse_github_timestamp(None) is None
    assert parse_github_timestamp("") is None
    # "Anything" has to include the wrong *type*, not just the wrong string:
    # this is reached straight off a webhook body, where the value is whatever
    # the request contained. `.replace` on a non-string raises AttributeError,
    # which on that route becomes an unhandled 500 and a GitHub retry.
    assert parse_github_timestamp(1755800000) is None
    assert parse_github_timestamp({"at": "2026-08-21T18:39:30Z"}) is None
    assert parse_github_timestamp(["2026-08-21T18:39:30Z"]) is None


def test_get_pull_request_diff_requests_diff_media_type() -> None:
    diff_text = "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Accept"] == "application/vnd.github.v3.diff"
        return httpx.Response(200, text=diff_text)

    assert _client(handler).get_pull_request_diff("octo", "hello", 7) == diff_text


def test_list_repository_files_filters_binaries_and_excluded_dirs() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/hello/git/trees/main"
        assert request.url.params["recursive"] == "1"
        return httpx.Response(
            200,
            json={
                "tree": [
                    {"path": "app/main.py", "type": "blob"},
                    {"path": "node_modules/x/index.js", "type": "blob"},
                    {"path": "logo.png", "type": "blob"},
                    {"path": "poetry.lock", "type": "blob"},
                    {"path": "frontend/package-lock.json", "type": "blob"},
                    {"path": "src", "type": "tree"},
                    {"path": "src/util.py", "type": "blob"},
                ]
            },
        )

    files = _client(handler).list_repository_files("octo", "hello", ref="main")
    assert files == ["app/main.py", "src/util.py"]


def test_get_repository_parses_metadata() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/hello"
        return httpx.Response(
            200, json={"id": 4242, "full_name": "octo/hello", "default_branch": "develop"}
        )

    meta = _client(handler).get_repository("octo", "hello")
    assert meta == RepositoryMeta(id=4242, full_name="octo/hello", default_branch="develop")


def test_get_file_content_returns_raw_text() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Accept"] == "application/vnd.github.raw"
        assert request.url.path == "/repos/octo/hello/contents/app/main.py"
        return httpx.Response(200, text="print('hi')\n")

    assert _client(handler).get_file_content("octo", "hello", "app/main.py") == "print('hi')\n"


def test_revoked_token_raises_auth_error_not_httpx() -> None:
    """A user can revoke the OAuth app's access at any time.

    That must surface as a typed error the API can turn into a clean 503
    "reconnect your GitHub account", not an httpx exception escaping as a 500.
    """
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "Bad credentials"})

    gh = GitHubClient(
        token="revoked",
        client=httpx.Client(transport=httpx.MockTransport(handler), base_url=GITHUB_API_BASE),
    )
    with pytest.raises(GitHubAuthError, match="reconnect"):
        gh.get_repository("octo", "demo")


def test_other_github_errors_stay_generic() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    gh = GitHubClient(
        token="t",
        client=httpx.Client(transport=httpx.MockTransport(handler), base_url=GITHUB_API_BASE),
    )
    with pytest.raises(GitHubError) as exc:
        gh.get_repository("octo", "demo")
    assert not isinstance(exc.value, GitHubAuthError)


# ── Which files reach the indexer (LANG-1) ───────────────────────────────────


@pytest.mark.parametrize(
    "path",
    [
        "backend/app/services/chunker.py",
        "frontend/src/components/review/ReviewComment.tsx",
        "frontend/src/lib/utils.ts",
        "frontend/src/main.jsx",
        "scripts/build.mjs",
    ],
)
def test_source_files_are_indexable(path: str) -> None:
    assert _is_indexable(path) is True


@pytest.mark.parametrize(
    "path,reason",
    [
        ("frontend/node_modules/react/index.js", "vendored dependencies"),
        ("frontend/dist/assets/index-abc123.js", "build output"),
        ("frontend/package-lock.json", "lockfile"),
        ("frontend/src/assets/hero.png", "binary"),
        ("frontend/public/app.min.js", "minified"),
        # Ambient declarations: signatures with no implementation. Harmless
        # before LANG-1 because they were never parsed semantically; now they
        # would chunk cleanly and crowd retrieval with declarations of the
        # very functions someone wanted the body of.
        ("frontend/src/vite-env.d.ts", "type declarations"),
        ("frontend/src/types/global.d.ts", "type declarations"),
    ],
)
def test_non_source_files_are_skipped(path: str, reason: str) -> None:
    assert _is_indexable(path) is False, reason


def test_node_modules_is_excluded_at_any_depth() -> None:
    """Asserted rather than assumed.

    Now that `.js` chunks semantically, indexing `node_modules` would take a
    very long time and produce tens of thousands of junk chunks. LANG-2
    depends on this holding.
    """
    assert _is_indexable("node_modules/left-pad/index.js") is False
    assert _is_indexable("frontend/node_modules/react/cjs/react.production.js") is False
    # A file merely *named* like it is fine.
    assert _is_indexable("frontend/src/lib/node_modules_helper.ts") is True


# ── Secrets and datastores must never be indexed (LANG-2) ────────────────────


# One table, accept and reject together, because the gaps that got through the
# first version of this predicate (.envrc, staging.env, .ENV) were all things
# nobody thought to write a separate test for.
_DOTENV_CASES = [
    # (path, must_be_excluded, why)
    ("backend/.env", True, "plain dotenv"),
    ("frontend/.env", True, "the one LANG-2's live run actually found indexed"),
    ("frontend/.env.local", True, "local override"),
    (".env.production.local", True, "compound suffix"),
    ("backend/.envrc", True, "direnv: raw `export AWS_SECRET_ACCESS_KEY=...`"),
    ("deploy/staging.env", True, "docker-compose env_file: convention"),
    ("docker.env", True, "same convention"),
    ("backend/.ENV", True, "git paths are case-sensitive even where the FS is not"),
    ("backend/.Env.Local", True, "mixed case"),
    ("PROD.ENV", True, "upper case, <name>.env form"),
    # Templates carry no values and are useful context for config questions.
    (".env.example", False, "template"),
    ("backend/.env.example", False, "template"),
    ("backend/.env.sample", False, "template"),
    ("backend/.env.template", False, "template"),
    ("backend/.env.dist", False, "template"),
    ("backend/.ENV.EXAMPLE", False, "template, upper case"),
    # Must not over-reach into ordinary source.
    ("frontend/src/lib/env.ts", False, "a module that happens to be named env"),
    ("backend/app/environment.py", False, "starts with 'env'"),
    ("docs/environment.md", False, "prose about environments"),
]


@pytest.mark.parametrize("path,excluded,why", _DOTENV_CASES)
def test_dotenv_exclusion(path: str, excluded: bool, why: str) -> None:
    """Found by LANG-2's live run, which embedded `backend/.env`.

    A dotenv holds the database password and API keys. Indexing one puts them
    in the vector store, where they come back as review context — and under a
    hosted embedding provider they are sent to a third party on the way in.
    """
    assert _is_indexable(path) is (not excluded), why


@pytest.mark.parametrize(
    "path",
    [
        "chroma/chroma.sqlite3",
        "backend/chroma/chroma.sqlite3",
        "data/app.db",
        "var/cache.sqlite",
        "models/model.onnx",
    ],
)
def test_datastores_are_not_indexed(path: str) -> None:
    """Chroma's own persist dir holds an 11MB chroma.sqlite3.

    Without this the index ingests its own storage: LANG-2's first live run
    produced 60 chunks of SQLite page data.
    """
    assert _is_indexable(path) is False


# ── Rate limiting is not an auth failure (#209) ───────────────────────────────
#
# GitHub answers **403 for rate limiting as well as for authorization
# failures**, so the status code alone cannot tell them apart. The
# discriminator is the headers.


def _erroring_client(status: int, headers: dict[str, str]) -> GitHubClient:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, headers=headers, json={"message": "nope"})

    return _client(handler)


def test_403_with_exhausted_rate_limit_is_a_rate_limit_error() -> None:
    """The primary hourly limit, carrying the time it lifts."""
    reset = 1_785_500_000
    gh = _erroring_client(
        403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(reset)}
    )

    with pytest.raises(GitHubRateLimitError) as caught:
        gh.get_repository("octo", "demo")

    assert caught.value.reset_at == datetime.fromtimestamp(reset, tz=timezone.utc)
    # The user-facing half: it must not tell anyone to reconnect.
    assert "reconnect" not in str(caught.value).lower()
    assert "rate limit" in str(caught.value).lower()


def test_403_with_retry_after_is_a_rate_limit_error() -> None:
    """The secondary ("abuse") limit shape, which carries no reset header."""
    gh = _erroring_client(403, {"retry-after": "60"})

    with pytest.raises(GitHubRateLimitError) as caught:
        gh.get_repository("octo", "demo")

    assert caught.value.retry_after == 60
    assert "60s" in str(caught.value)


def test_429_is_a_rate_limit_error_even_without_headers() -> None:
    """GitHub does not use 429 for anything else."""
    gh = _erroring_client(429, {})

    with pytest.raises(GitHubRateLimitError):
        gh.get_repository("octo", "demo")


def test_403_without_rate_limit_headers_is_still_an_auth_error() -> None:
    """The revoked-token case must not regress — it is the actionable one."""
    gh = _erroring_client(403, {})

    with pytest.raises(GitHubAuthError) as caught:
        gh.get_repository("octo", "demo")

    assert not isinstance(caught.value, GitHubRateLimitError)
    assert "reconnect" in str(caught.value).lower()


def test_403_with_remaining_quota_is_an_auth_error() -> None:
    """`x-ratelimit-remaining` present but non-zero: quota is fine, so this is
    a permissions problem and the reconnect message is correct."""
    gh = _erroring_client(403, {"x-ratelimit-remaining": "4999"})

    with pytest.raises(GitHubAuthError) as caught:
        gh.get_repository("octo", "demo")
    assert not isinstance(caught.value, GitHubRateLimitError)


def test_401_is_still_an_auth_error() -> None:
    gh = _erroring_client(401, {})

    with pytest.raises(GitHubAuthError):
        gh.get_repository("octo", "demo")


def test_401_with_rate_limit_headers_is_still_an_auth_error() -> None:
    """A 401 is never a rate limit, whatever headers ride along with it.

    Only 403 and 429 are ambiguous; classifying a 401 by headers would let a
    stray header turn a dead token into "wait a while".
    """
    gh = _erroring_client(401, {"x-ratelimit-remaining": "0"})

    with pytest.raises(GitHubAuthError) as caught:
        gh.get_repository("octo", "demo")
    assert not isinstance(caught.value, GitHubRateLimitError)


def test_rate_limit_error_survives_an_unparseable_reset_header() -> None:
    """A limit we cannot put a time on is still a limit.

    Losing the classification over a bad header would land straight back on
    "reconnect your account", which is the bug this all exists to remove.
    """
    gh = _erroring_client(403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "soon"})

    with pytest.raises(GitHubRateLimitError) as caught:
        gh.get_repository("octo", "demo")

    assert caught.value.reset_at is None


def test_rate_limit_error_is_a_github_error() -> None:
    """Callers with a broad `except GitHubError` still catch it — which is also
    why every chain has to catch the specific one first."""
    assert issubclass(GitHubRateLimitError, GitHubError)
    assert not issubclass(GitHubRateLimitError, GitHubAuthError)


# ── new-file line -> commentable? (GH-1) ──────────────────────────────────────
#
# The majority of this issue's value. GitHub 422s the **whole review** if any
# one comment names a line that is not part of the diff, so being wrong here
# does not cost one comment — it costs all of them.

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

DELETED_FILE_DIFF = """\
diff --git a/gone.py b/gone.py
deleted file mode 100644
--- a/gone.py
+++ /dev/null
@@ -1,3 +0,0 @@
-a
-b
-c
"""

BINARY_DIFF = """\
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
"""


def _diffs(raw: str):
    return parse_diff(raw)


def test_line_inside_hunk_is_commentable() -> None:
    diffs = _diffs(TWO_HUNK_DIFF)
    # `+import sys` is new-file line 2.
    assert is_line_commentable(diffs, "app/main.py", 2)


def test_line_in_context_but_unchanged_is_commentable() -> None:
    """GitHub allows comments on context lines within a hunk.

    Excluding them would silently drop valid comments — a review's most useful
    remark is often on the line *above* the change.
    """
    diffs = _diffs(TWO_HUNK_DIFF)
    # `import os` is unchanged context, new-file line 1.
    assert is_line_commentable(diffs, "app/main.py", 1)


def test_line_outside_every_hunk_is_not_commentable() -> None:
    diffs = _diffs(TWO_HUNK_DIFF)
    # Line 25 sits in the gap between the two hunks: real in the file, absent
    # from the diff, and a 422 if sent.
    assert not is_line_commentable(diffs, "app/main.py", 25)


def test_a_removed_line_contributes_no_commentable_new_file_line() -> None:
    """A `-` line exists only on the left, so `side: RIGHT` cannot reach it —
    and crucially it must not shift the new-file numbering.

    The hunk below removes one line from the middle of three. New-file lines
    are 10 and 11; there is no 12. If removed lines leaked into the mapping
    the count would be three and every comment after this hunk would anchor
    one line low — the quiet kind of wrong, since each individual line still
    looks plausible.
    """
    raw = (
        "diff --git a/x.py b/x.py\n"
        "--- a/x.py\n"
        "+++ b/x.py\n"
        "@@ -10,3 +10,2 @@\n"
        " keep\n"
        "-gone\n"
        " tail\n"
    )
    diffs = _diffs(raw)

    assert is_line_commentable(diffs, "x.py", 10)
    assert is_line_commentable(diffs, "x.py", 11)
    assert not is_line_commentable(diffs, "x.py", 12)


def test_unknown_path_is_not_commentable() -> None:
    assert not is_line_commentable(_diffs(TWO_HUNK_DIFF), "not/in/diff.py", 1)


def test_deleted_file_has_no_commentable_lines() -> None:
    """Its content exists only on the left; RIGHT has nothing to point at."""
    diffs = _diffs(DELETED_FILE_DIFF)
    assert not is_line_commentable(diffs, "gone.py", 1)
    assert not is_line_commentable(diffs, "gone.py", 2)


def test_binary_file_has_no_commentable_lines() -> None:
    assert not is_line_commentable(_diffs(BINARY_DIFF), "logo.png", 1)


def test_empty_diff_has_no_commentable_lines() -> None:
    assert not is_line_commentable(_diffs(""), "anything.py", 1)


def test_multiline_span_within_one_hunk_is_allowed() -> None:
    diffs = _diffs(TWO_HUNK_DIFF)
    assert is_span_commentable(diffs, "app/main.py", 1, 3)


def test_multiline_span_across_two_hunks_is_rejected() -> None:
    """The case that produces a 422 in production.

    Both ends are individually valid, so a check written as two
    `is_line_commentable` calls would pass this and then fail the whole review.
    """
    diffs = _diffs(TWO_HUNK_DIFF)
    assert is_line_commentable(diffs, "app/main.py", 2)
    assert is_line_commentable(diffs, "app/main.py", 42)
    assert not is_span_commentable(diffs, "app/main.py", 2, 42)


def test_degenerate_span_is_a_single_line_comment() -> None:
    diffs = _diffs(TWO_HUNK_DIFF)
    assert is_span_commentable(diffs, "app/main.py", 2, 2)


def test_inverted_span_is_rejected() -> None:
    assert not is_span_commentable(_diffs(TWO_HUNK_DIFF), "app/main.py", 3, 1)


# ── The write path (GH-1) ─────────────────────────────────────────────────────


def test_create_review_posts_to_the_correct_url_with_event_and_comments() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["method"] = request.method
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"id": 991, "html_url": "https://github.com/o/r/pull/7#r991",
                       "state": "COMMENTED"}
        )

    comments = [{"path": "a.py", "line": 3, "side": "RIGHT", "body": "nit"}]
    _client(handler).create_pull_request_review(
        "octo", "demo", 7, body="summary", event="COMMENT", comments=comments
    )

    assert seen["method"] == "POST"
    assert seen["url"].endswith("/repos/octo/demo/pulls/7/reviews")
    # The body, not just the status: the event and the comment payload are the
    # part GitHub actually acts on.
    assert seen["body"] == {"body": "summary", "event": "COMMENT", "comments": comments}


def test_create_review_returns_id_and_url() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"id": 42, "html_url": "https://example.test/r/42", "state": "COMMENTED"}
        )

    posted = _client(handler).create_pull_request_review(
        "octo", "demo", 1, body="s", event="COMMENT"
    )

    assert posted.id == 42
    assert posted.html_url == "https://example.test/r/42"
    assert posted.state == "COMMENTED"


def test_create_review_omits_comments_when_there_are_none() -> None:
    """A summary-only review is legitimate — an empty list is not the same as
    the key being absent, and #196 posts one when nothing is anchorable."""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"id": 1, "html_url": "u", "state": "COMMENTED"})

    _client(handler).create_pull_request_review("o", "r", 1, body="s", event="COMMENT")
    assert "comments" not in seen["body"]


def test_create_review_422_raises_with_githubs_message() -> None:
    """The body must survive into the exception.

    A bare "HTTP 422" is unactionable; GitHub's message names the offending
    field, and that is the only way to find out *which* line was wrong.
    """
    detail = '{"message":"Unprocessable Entity","errors":[{"field":"pull_request_review_thread.line"}]}'

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, text=detail)

    with pytest.raises(GitHubWriteError) as caught:
        _client(handler).create_pull_request_review("o", "r", 1, body="s", event="COMMENT")

    assert caught.value.status_code == 422
    assert "pull_request_review_thread.line" in caught.value.body
    assert "pull_request_review_thread.line" in str(caught.value)


def test_create_review_401_and_403_stay_auth_errors() -> None:
    """The write path inherits #209's taxonomy rather than inventing its own."""
    for status in (401, 403):
        def handler(_request: httpx.Request, _status=status) -> httpx.Response:
            return httpx.Response(_status, text="nope")

        with pytest.raises(GitHubAuthError):
            _client(handler).create_pull_request_review("o", "r", 1, body="s", event="COMMENT")


def test_create_review_rate_limit_is_distinguishable_from_permissions() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, headers={"retry-after": "30"}, text="slow down")

    with pytest.raises(GitHubRateLimitError) as caught:
        _client(handler).create_pull_request_review("o", "r", 1, body="s", event="COMMENT")
    assert caught.value.retry_after == 30


def test_create_issue_comment_posts_the_body_and_returns_the_url() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json={"html_url": "https://example.test/c/1"})

    url = _client(handler).create_issue_comment("octo", "demo", 7, "hello")

    # PRs are issues for this endpoint.
    assert seen["url"].endswith("/repos/octo/demo/issues/7/comments")
    assert seen["body"] == {"body": "hello"}
    assert url == "https://example.test/c/1"


def test_post_uses_the_same_auth_headers_as_get() -> None:
    """One `_headers()`, not a second call style that could drift."""
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.headers))
        if request.method == "GET":
            return httpx.Response(200, json={"id": 1, "full_name": "o/r", "default_branch": "main"})
        return httpx.Response(200, json={"id": 1, "html_url": "u", "state": "COMMENTED"})

    gh = _client(handler)
    gh.get_repository("o", "r")
    gh.create_pull_request_review("o", "r", 1, body="s", event="COMMENT")

    get_headers, post_headers = seen
    for key in ("authorization", "accept", "x-github-api-version"):
        assert get_headers[key] == post_headers[key]
