import httpx
import pytest

from app.config import settings
from app.services.github_service import (
    GitHubAuthError,
    GitHubClient,
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
