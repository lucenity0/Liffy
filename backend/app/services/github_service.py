import hashlib
import hmac
from dataclasses import dataclass

import httpx

from app.config import settings

GITHUB_API_BASE = "https://api.github.com"
_DEFAULT_TIMEOUT = 30.0

# Directories and file types we never index or embed.
_EXCLUDED_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".turbo",
    "vendor",
    ".mypy_cache",
    ".pytest_cache",
}
_EXCLUDED_FILENAMES = {"package-lock.json", "pnpm-lock.yaml", "composer.lock", "Cargo.lock"}
_BINARY_SUFFIXES = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
    ".pdf", ".zip", ".gz", ".tar", ".mp4", ".mov", ".mp3", ".wav",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".lock", ".min.js", ".min.css", ".map",
    ".so", ".dylib", ".dll", ".pyc", ".class", ".jar", ".wasm",
)


class GitHubError(RuntimeError):
    """Base error for GitHub service failures."""


class GitHubAuthError(GitHubError):
    """Raised when no GitHub token is available."""


def verify_webhook_signature(secret: str, payload: bytes, signature_header: str | None) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    signature = signature_header.split("=", 1)[1]
    digest = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, digest)


def get_github_token(token: str | None = None) -> str:
    """Resolve a GitHub token.

    This is the seam for future OAuth: callers may pass a per-user token, and
    when absent we fall back to the server-side PAT in ``settings.github_token``.
    """
    resolved = token or settings.github_token
    if not resolved:
        raise GitHubAuthError("No GitHub token configured; set GITHUB_TOKEN or pass a token.")
    return resolved


@dataclass(frozen=True)
class PullRequestMeta:
    number: int
    title: str
    author: str
    base_branch: str
    head_branch: str
    head_sha: str
    state: str


@dataclass(frozen=True)
class RepositoryMeta:
    id: int
    full_name: str
    default_branch: str


def _is_indexable(path: str) -> bool:
    parts = path.split("/")
    if any(part in _EXCLUDED_DIRS for part in parts):
        return False
    if parts[-1] in _EXCLUDED_FILENAMES:
        return False
    # Ambient type declarations: signatures with no implementation behind
    # them. They chunk cleanly now that TypeScript is indexed (LANG-1), which
    # is the problem — they would crowd retrieval results with declarations
    # of the very functions someone was looking for the body of.
    if path.lower().endswith(".d.ts"):
        return False
    return not path.lower().endswith(_BINARY_SUFFIXES)


class GitHubClient:
    """Thin synchronous wrapper over the GitHub REST API.

    Pass ``client`` (e.g. an ``httpx.Client`` backed by ``httpx.MockTransport``)
    to inject a stubbed transport in tests.
    """

    def __init__(self, token: str | None = None, *, client: httpx.Client | None = None) -> None:
        self.token = get_github_token(token)
        self._client = client or httpx.Client(base_url=GITHUB_API_BASE, timeout=_DEFAULT_TIMEOUT)

    def __enter__(self) -> "GitHubClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def _headers(self, accept: str = "application/vnd.github+json") -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": accept,
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _get(
        self,
        path: str,
        *,
        accept: str = "application/vnd.github+json",
        params: dict[str, str] | None = None,
    ) -> httpx.Response:
        response = self._client.get(path, headers=self._headers(accept), params=params)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            # A user can revoke the OAuth app's access from GitHub's settings
            # at any time, so a token that worked yesterday returning 401
            # today is normal operation, not a defect. Translating it into a
            # typed error here is what lets the API answer "reconnect your
            # GitHub account" instead of leaking an httpx exception as a 500.
            if response.status_code in (401, 403):
                raise GitHubAuthError(
                    "GitHub rejected the credentials. If you revoked Liffy's "
                    "access, reconnect your GitHub account."
                ) from exc
            raise GitHubError(f"GitHub returned HTTP {response.status_code}") from exc
        return response

    def get_pull_request(self, owner: str, repo: str, number: int) -> PullRequestMeta:
        data = self._get(f"/repos/{owner}/{repo}/pulls/{number}").json()
        head = data.get("head") or {}
        return PullRequestMeta(
            number=int(data["number"]),
            title=data.get("title") or "",
            author=(data.get("user") or {}).get("login", ""),
            base_branch=(data.get("base") or {}).get("ref", ""),
            head_branch=head.get("ref", ""),
            head_sha=head.get("sha", ""),
            state=data.get("state", ""),
        )

    def get_pull_request_diff(self, owner: str, repo: str, number: int) -> str:
        response = self._get(
            f"/repos/{owner}/{repo}/pulls/{number}",
            accept="application/vnd.github.v3.diff",
        )
        return response.text

    def get_repository(self, owner: str, repo: str) -> RepositoryMeta:
        data = self._get(f"/repos/{owner}/{repo}").json()
        return RepositoryMeta(
            id=int(data["id"]),
            full_name=data.get("full_name", f"{owner}/{repo}"),
            default_branch=data.get("default_branch", "main"),
        )

    def get_default_branch(self, owner: str, repo: str) -> str:
        return self.get_repository(owner, repo).default_branch

    def list_repository_files(self, owner: str, repo: str, ref: str | None = None) -> list[str]:
        tree_ref = ref or self.get_default_branch(owner, repo)
        data = self._get(
            f"/repos/{owner}/{repo}/git/trees/{tree_ref}",
            params={"recursive": "1"},
        ).json()
        return [
            item["path"]
            for item in data.get("tree", [])
            if item.get("type") == "blob" and _is_indexable(item["path"])
        ]

    def get_file_content(self, owner: str, repo: str, path: str, ref: str | None = None) -> str:
        params = {"ref": ref} if ref else None
        response = self._get(
            f"/repos/{owner}/{repo}/contents/{path}",
            accept="application/vnd.github.raw",
            params=params,
        )
        return response.text
