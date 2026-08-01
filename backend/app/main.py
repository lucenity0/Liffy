from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import analytics, auth, feedback, repos, reviews, settings as settings_api, webhook
from app.config import settings
from app.database import SessionLocal
from app.services.settings_service import refresh_overrides

log = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Load stored settings overrides before serving the first request.

    Without this the override store starts empty and a setting saved yesterday
    stays invisible until somebody happens to write another one — which reads
    as the settings page having quietly forgotten, and is a far more likely
    complaint than any of the cases the write path handles.

    Failure here is logged and swallowed. A database that is not up yet must
    not stop the API booting: every setting then reads from `.env`, which is
    exactly the behaviour before this feature existed.
    """
    try:
        with SessionLocal() as db:
            refresh_overrides(db)
    except Exception as exc:  # pragma: no cover - depends on a broken database
        log.warning("settings.startup_load_failed", error=str(exc))
    yield


app = FastAPI(title="Liffy API", lifespan=lifespan)

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
app.include_router(analytics.router, prefix="/analytics", tags=["analytics"])
app.include_router(settings_api.router, tags=["settings"])


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
