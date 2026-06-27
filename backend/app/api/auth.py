from fastapi import APIRouter

router = APIRouter()


@router.get("/github")
def github_login() -> dict[str, str]:
    return {"message": "GitHub OAuth redirect placeholder"}


@router.get("/github/callback")
def github_callback() -> dict[str, str]:
    return {"access_token": "placeholder", "refresh_token": "placeholder"}


@router.post("/refresh")
def refresh_token() -> dict[str, str]:
    return {"access_token": "placeholder"}


@router.post("/logout")
def logout() -> dict[str, str]:
    return {"message": "ok"}
