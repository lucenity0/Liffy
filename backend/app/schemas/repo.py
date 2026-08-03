import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator


class RepoConnectRequest(BaseModel):
    full_name: str  # "owner/name"

    @field_validator("full_name")
    @classmethod
    def _owner_slash_name(cls, value: str) -> str:
        value = value.strip().strip("/")
        if value.count("/") != 1 or not all(part for part in value.split("/")):
            raise ValueError("full_name must look like 'owner/name'")
        return value


class RepoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    full_name: str
    default_branch: str
    indexed_at: datetime | None
    created_at: datetime


class RepoListItemOut(RepoOut):
    """A repository plus its review history, for the list.

    A subclass rather than two more fields on ``RepoOut``, because these are
    computed by the list query and nothing else has them. Defaulting them on
    the base model would let ``POST /repos`` answer ``review_count: 0`` for a
    repository being *re*-connected — a repository that may well have a
    hundred reviews behind it — and a wrong count is worse than an absent one.
    """

    # Every review, not only completed ones: this answers "how much has Liffy
    # done here", and a failed run is still an attempt that happened.
    review_count: int
    # ``None`` on a repository nothing has reviewed yet — never epoch, and
    # never the connection date standing in for a review that never happened.
    last_review_at: datetime | None


class RepoStatusOut(BaseModel):
    id: uuid.UUID
    full_name: str
    status: str  # "indexed" | "indexing" | "not_indexed"
    indexed_at: datetime | None
    chunk_count: int
    # How the last index run went. Both null on repositories indexed before
    # these were recorded — which is why they are nullable rather than
    # defaulting to 0: "never measured" and "measured, nothing failed" are
    # different, and only the second deserves a clean chip.
    #
    # A non-zero failed count means the index is *partial*: those files have no
    # chunks, so reviews touching them retrieve no context. Without this the
    # partial case renders identically to a complete one.
    last_index_failed_files: int | None
    last_indexed_files_seen: int | None


class PullRequestOut(BaseModel):
    """One pull request, as much as a picker needs to identify it.

    No diff and no body: this backs the "which pull request?" step of
    starting a review, and the diff is fetched per-PR by the worker for the
    one actually chosen.
    """

    number: int
    title: str
    author: str
    head_branch: str
    base_branch: str
    state: str  # "open" | "closed"


class PullRequestListOut(BaseModel):
    """One page of pull requests, and whether it is the whole set.

    `total` is null when the page came back full, because then the count is
    genuinely unknown without paging the rest — and a picker tab reading
    "OPEN 50" on a repository with 200 open pull requests is worse than one
    reading "OPEN". Populated only when the page is short, which is when it
    is provably the complete answer.
    """

    items: list[PullRequestOut]
    state: str
    total: int | None
