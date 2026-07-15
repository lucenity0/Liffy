import hashlib

import chromadb

from app.llm.chain import LLMResponse
from app.services.github_service import PullRequestMeta, RepositoryMeta

# One ephemeral Chroma client for the whole test session, created eagerly on
# the MAIN thread: chromadb's in-process system DB misbehaves when clients are
# (first-)created across threads (e.g. inside TestClient worker threads).
# Collections are namespaced by repo UUID, so sharing keeps tests isolated.
_chroma_client = chromadb.EphemeralClient()


def shared_chroma_client() -> "chromadb.api.ClientAPI":
    return _chroma_client


class DeterministicEmbeddings:
    """Offline stand-in for OpenAIEmbeddings: stable 32-dim vectors derived
    from the text hash. Identical texts embed identically, so exact-match
    queries return distance ~0. Tracks batch sizes for embedding-volume
    assertions."""

    def __init__(self) -> None:
        self.calls: list[int] = []

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(len(texts))
        out = []
        for text in texts:
            digest = hashlib.sha256(text.encode()).digest()
            out.append([b / 255.0 for b in digest[:32]])
        return out


class FakeGitHub:
    """In-memory stand-in for GitHubClient (duck-typed): repo files for the
    indexer, PR metadata + diff for the review pipeline."""

    def __init__(
        self,
        files: dict[str, str] | None = None,
        pr_meta: PullRequestMeta | None = None,
        pr_diff: str = "",
        repo_meta: RepositoryMeta | None = None,
    ) -> None:
        self.files = files or {}
        self.pr_meta = pr_meta
        self.pr_diff = pr_diff
        self.repo_meta = repo_meta

    def get_repository(self, owner: str, repo: str) -> RepositoryMeta:
        assert self.repo_meta is not None, "FakeGitHub built without repo_meta"
        return self.repo_meta

    def __enter__(self) -> "FakeGitHub":
        return self

    def __exit__(self, *_exc: object) -> None:
        pass

    def list_repository_files(self, owner: str, repo: str, ref: str | None = None) -> list[str]:
        return sorted(self.files)

    def get_file_content(self, owner: str, repo: str, path: str, ref: str | None = None) -> str:
        return self.files[path]

    def get_pull_request(self, owner: str, repo: str, number: int) -> PullRequestMeta:
        assert self.pr_meta is not None, "FakeGitHub built without pr_meta"
        return self.pr_meta

    def get_pull_request_diff(self, owner: str, repo: str, number: int) -> str:
        return self.pr_diff

    def close(self) -> None:
        pass


class FakeLLM:
    """Scripted ReviewLLM: returns canned responses in order, records prompts."""

    model_name = "fake-model"

    def __init__(self, responses: list[str], tokens_per_call: int = 100) -> None:
        self.responses = list(responses)
        self.tokens_per_call = tokens_per_call
        self.prompts: list[tuple[str, str]] = []

    def complete(self, system: str, user: str) -> LLMResponse:
        self.prompts.append((system, user))
        return LLMResponse(text=self.responses.pop(0), tokens_used=self.tokens_per_call)
