"""Celery application.

Running the worker on macOS: use ``--pool=solo`` (or ``--pool=threads``).

Celery's default prefork pool calls ``fork()``, and this worker imports
chromadb, which initialises Objective-C runtime state in the parent. The forked
child then aborts with ``SIGABRT`` before the task runs, which surfaces as
``WorkerLostError`` — a lost task rather than an import error, so it is easily
misread as a bug in the task itself. Linux is unaffected, so the Docker worker
needs no change; this is a local-development concern only.
"""

from celery import Celery
from celery.schedules import crontab

from app.config import settings

# Every module holding a @celery.task must be listed. A task that is scheduled
# but not imported fails at execution with `Received unregistered task`, which
# reads like a broker problem rather than a one-line omission here — so
# test_celery_app.py asserts the list rather than trusting it.
celery = Celery(
    "liffy",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "app.workers.review_worker",
        "app.workers.index_worker",
        "app.workers.eval_worker",
        "app.workers.pr_state_worker",
    ],
)

celery.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    # One message in hand at a time. The default lets a worker reserve several
    # up front, which does nothing for throughput on tasks that take minutes
    # and costs everything when the process dies: a worker killed while holding
    # four reserved messages loses all four, not just the one it was running.
    worker_prefetch_multiplier=1,
    beat_schedule={
        # Report §8.2: "a weekly Celery beat job computes eval_scores for all
        # completed reviews."
        #
        # `crontab`, not `timedelta(days=7)`. A timedelta is relative to the
        # last run and re-anchors whenever beat restarts, so on a project under
        # active development "weekly" quietly becomes "whenever" — and the
        # persisted series §8.1's trend depends on ends up unevenly spaced.
        # `timezone` above is UTC, so Monday 03:00 is unambiguous.
        "compute-eval-scores-weekly": {
            "task": "liffy.compute_eval_scores",
            "schedule": crontab(hour=3, minute=0, day_of_week=1),
        },
        # Pull request state goes stale silently. The webhook catches `closed`
        # for repositories Liffy was listening to at the time; this catches the
        # rest — a repository connected after the fact, a delivery that failed
        # while the worker was down, a pull request closed during an outage.
        #
        # Daily, not weekly: the calibration audit reads this column, and a
        # metric that is a week behind reality reads as a metric that is wrong.
        # It is one API call per not-yet-closed pull request, so the cost scales
        # with open work rather than with history.
        #
        # `crontab`, not `timedelta`, for the reason spelled out above — and
        # 04:00 rather than 03:00 so it does not contend with the eval job.
        "sync-pull-request-state-daily": {
            "task": "liffy.sync_pull_request_state",
            "schedule": crontab(hour=4, minute=0),
        },
    },
)
