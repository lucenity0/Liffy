from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import auth, feedback, repos, reviews, webhook
from app.config import settings

app = FastAPI(title="Liffy API")

# The Vite dev server runs on a different origin; without this the browser blocks
# every call. No credentials yet — there are no cookies until the auth milestone.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(repos.router, prefix="/repos", tags=["repos"])
app.include_router(reviews.router, tags=["reviews"])
app.include_router(webhook.router, prefix="/webhook", tags=["webhook"])
app.include_router(feedback.router, tags=["feedback"])


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
