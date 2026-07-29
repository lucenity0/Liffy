"""Celery application.

Running the worker on macOS: use ``--pool=solo`` (or ``--pool=threads``).

Celery's default prefork pool calls ``fork()``, and this worker imports
chromadb, which loads onnxruntime and initialises Objective-C runtime state in
the parent. The forked child then aborts before the task runs:

    objc[...]: +[NSCharacterSet initialize] may have been in progress in
    another thread when fork() was called. ... Crashing instead.
    WorkerLostError: Worker exited prematurely: signal 6 (SIGABRT)

It presents as a lost task rather than an import error, so it is easy to
misread as a bug in the task itself. Linux is unaffected, which means the
Docker worker needs no change — this is a local-development concern only.
"""

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
