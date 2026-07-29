import httpx
import pytest

from app.config import settings
from app.services.github_service import (
    GITHUB_API_BASE,
    _is_indexable,
    GitHubAuthError,
    GitHubClient,
    GitHubError,
    PullRequestMeta,
    RepositoryMeta,
    get_github_token,
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
