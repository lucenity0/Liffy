from fastapi import FastAPI

from app.api import auth, feedback, repos, reviews, webhook

app = FastAPI(title="Liffy API")
app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(repos.router, prefix="/repos", tags=["repos"])
app.include_router(reviews.router, tags=["reviews"])
app.include_router(webhook.router, prefix="/webhook", tags=["webhook"])
app.include_router(feedback.router, tags=["feedback"])


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
