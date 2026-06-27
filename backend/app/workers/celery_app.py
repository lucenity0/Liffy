from celery import Celery
from app.config import settings

celery = Celery(
    "liffy",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.workers.review_worker", "app.workers.index_worker"]
)

celery.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
)
