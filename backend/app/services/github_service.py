import hashlib
import hmac
from dataclasses import dataclass
from datetime import datetime, timezone

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
    # Datastores and serialised blobs. Chroma's persist directory holds an
    # 11MB chroma.sqlite3 and a .pickle of index metadata, so a repository
    # that commits one — or any future caller that indexes a working tree
    # rather than a git tree — would otherwise ingest the vector store itself.
    ".sqlite", ".sqlite3", ".db", ".mdb", ".bin", ".onnx", ".pack", ".idx",
    ".pickle", ".pkl", ".npy", ".npz", ".parquet",
)

# Suffixes that mark a dotenv file as a *template* rather than real secrets.
_ENV_TEMPLATE_SUFFIXES = (".example", ".sample", ".template", ".dist")


def _is_dotenv_with_secrets(filename: str) -> bool:
    """`.env`, `.env.local`, `.envrc`, `staging.env` — but not `.env.example`.

    A dotenv holds database passwords and API keys. Indexing one embeds them
    into the vector store, where they are retrievable as review context and,
    under a hosted embedding provider, are sent to a third party on the way
    in.

    **Preventive, not a fix for a leak that happened.** Liffy indexes through
    GitHub's git-tree API, which only returns *tracked* files, and a dotenv is
    gitignored in any repository that has its house in order — this one
    included. The case this defends against is a repository where somebody
    committed one, which is common enough to be worth ten lines: this
    predicate runs against whatever repository a user connects, not against
    this one.

    Four shapes, because this runs against whatever repository a user
    connects rather than only against this one:

    - ``.env`` and ``.env.<anything>`` — the common case.
    - ``.envrc`` — direnv. Raw ``export AWS_SECRET_ACCESS_KEY=...`` with no
      quoting or structure to hide behind, so it embeds and retrieves
      cleanly.
    - ``<name>.env`` — ``staging.env``, ``docker.env``, the convention
      docker-compose's ``env_file:`` encourages.
    - Any of the above in a different case. Git paths are case-sensitive even
      where the filesystem is not, and the two checks below this one in
      ``_is_indexable`` both lowercase first.

    Templates are deliberately still indexed: they are documentation, they
    carry no values, and they are genuinely useful retrieval context for
    configuration questions.
    """
    lowered = filename.lower()
    is_dotenv = (
        lowered.startswith(".env.")
        or lowered == ".envrc"
        # Subsumes a bare `.env` as well as the `<name>.env` convention.
        or lowered.endswith(".env")
    )
    if not is_dotenv:
        return False
    return not lowered.endswith(_ENV_TEMPLATE_SUFFIXES)


class GitHubError(RuntimeError):
    """Base error for GitHub service failures."""


class GitHubAuthError(GitHubError):
    """The credential is the problem: absent, revoked, or lacking the scope.

    Actionable — it needs the user to reconnect. Deliberately **not** raised
    for a rate limit, which is transient and self-healing; see
    ``GitHubRateLimitError``.
    """


class GitHubRateLimitError(GitHubError):
    """The credential is fine; there is no quota left right now.

    GitHub returns **403 for rate limiting as well as for authorization
    failures**, so status code alone cannot tell them apart. Conflating them
    means the actionable message — "reconnect your GitHub account" — fires for
    the one case where there is no action to take, about an account that is
    perfectly healthy.

    ``reset_at`` is when the primary limit lifts (epoch seconds, from
    ``x-ratelimit-reset``); ``retry_after`` is the secondary-limit hint in
    seconds. Either may be absent — GitHub does not always send both — so both
    are optional and the message degrades to naming the limit without a time.

    A subclass of ``GitHubError`` like ``GitHubAuthError``, which means **every
    ``except`` chain has to catch this one first**. ``indexer.py`` already has
    that shape from #208.
    """

    def __init__(
        self,
        message: str,
        *,
        reset_at: datetime | None = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message)
        self.reset_at = reset_at
        self.retry_after = retry_after


def _rate_limit_from(response: httpx.Response) -> GitHubRateLimitError | None:
    """Classify a 403/429 as a rate limit, or ``None`` if it is not one.

    The discriminator is the headers, not the status:

    - ``x-ratelimit-remaining: 0`` — the primary hourly limit is exhausted, and
      ``x-ratelimit-reset`` carries the epoch second it lifts.
    - ``retry-after`` — the secondary ("abuse") limit, in seconds.
    - neither — a genuine authorization failure, which the caller maps to
      ``GitHubAuthError``.

    A 429 is always a rate limit whatever the headers say; GitHub does not use
    that status for anything else.

    **Only 403 and 429 are ambiguous.** A 401 means the credential is bad, full
    stop — GitHub attaches rate-limit headers to most responses, so classifying
    by headers alone would let a stray ``x-ratelimit-remaining: 0`` turn a dead
    token into "wait a while", which is the same conflation in the opposite
    direction.
    """
    if response.status_code not in (403, 429):
        return None

    headers = response.headers
    remaining = headers.get("x-ratelimit-remaining")
    retry_after_raw = headers.get("retry-after")

    primary = remaining is not None and remaining.strip() == "0"
    secondary = retry_after_raw is not None
    if not (primary or secondary or response.status_code == 429):
        return None

    # Both values come off the wire, so neither is trusted to parse. A limit we
    # cannot put a time on is still a limit — losing the classification over an
    # unparseable header would put us straight back to "reconnect your
    # account", which is the bug this function exists to remove.
    reset_at: datetime | None = None
    reset_raw = headers.get("x-ratelimit-reset")
    if reset_raw is not None:
        try:
            reset_at = datetime.fromtimestamp(int(reset_raw), tz=timezone.utc)
        except (ValueError, OverflowError, OSError):
            reset_at = None

    retry_after: int | None = None
    if retry_after_raw is not None:
        try:
            retry_after = int(retry_after_raw)
        except ValueError:
            retry_after = None

    if retry_after is not None:
        when = f" Retry after {retry_after}s."
    elif reset_at is not None:
        when = f" The limit resets at {reset_at:%Y-%m-%d %H:%M:%S} UTC."
    else:
        when = ""
    return GitHubRateLimitError(
        f"GitHub rate limit reached.{when} Your account is fine — this is "
        "quota, not credentials.",
        reset_at=reset_at,
        retry_after=retry_after,
    )


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
    if _is_dotenv_with_secrets(parts[-1]):
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
            # Rate limiting first, because GitHub answers 403 for *both* a
            # rate limit and an authorization failure. Checked before the auth
            # branch below rather than after, since the auth branch would
            # otherwise swallow every 403 and tell the user to reconnect a
            # perfectly healthy account — for a condition that fixes itself.
            #
            # At 5000 req/hr this is the likeliest large-repo failure there is:
            # `index_repository` issues one content request per file.
            rate_limited = _rate_limit_from(response)
            if rate_limited is not None:
                raise rate_limited from exc

            # A user can revoke the OAuth app's access from GitHub's settings
            # at any time, so a token that worked yesterday returning 401
            # today is normal operation, not a defect. Translating it into a
            # typed error here is what lets the API answer "reconnect your
            # GitHub account" instead of leaking an httpx exception as a 500.
            #
            # A 403 reaches here only with neither rate-limit header present,
            # which is the genuine permissions case.
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
