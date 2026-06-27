from fastapi import APIRouter

router = APIRouter()


@router.get("")
def list_repos() -> list[dict[str, str]]:
    return []


@router.post("")
def connect_repo() -> dict[str, str]:
    return {"status": "connected"}


@router.delete("/{repo_id}")
def disconnect_repo(repo_id: str) -> dict[str, str]:
    return {"repo_id": repo_id, "status": "disconnected"}


@router.post("/{repo_id}/index")
def trigger_index(repo_id: str) -> dict[str, str]:
    return {"repo_id": repo_id, "status": "queued"}


@router.get("/{repo_id}/status")
def repo_status(repo_id: str) -> dict[str, str]:
    return {"repo_id": repo_id, "status": "idle"}


@router.get("/{repo_id}/analytics")
def repo_analytics(repo_id: str) -> dict[str, float | str]:
    return {"repo_id": repo_id, "approval_rate": 0.0, "false_positive_rate": 0.0}
