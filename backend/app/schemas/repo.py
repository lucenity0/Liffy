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


class RepoStatusOut(BaseModel):
    id: uuid.UUID
    full_name: str
    status: str  # "indexed" | "not_indexed"
    indexed_at: datetime | None
    chunk_count: int
