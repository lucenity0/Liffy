"""Celery wiring (EVAL-3).

Small tests for a failure mode that is otherwise invisible until a Monday: a
task that is *scheduled* but not *imported* fails at execution with
``Received unregistered task``, which reads like a broker fault rather than a
missing entry in one list.
"""

from celery.schedules import crontab

from app.workers.celery_app import celery


def test_eval_worker_module_is_in_include() -> None:
    """The omission the issue calls out, caught by a test instead of by a
    silent Monday."""
    assert "app.workers.eval_worker" in celery.conf.include


def test_every_worker_module_is_included() -> None:
    """The same guard for the modules that were already there."""
    assert set(celery.conf.include) == {
        "app.workers.review_worker",
        "app.workers.index_worker",
        "app.workers.eval_worker",
    }


def test_beat_schedule_registers_the_eval_task() -> None:
    entry = celery.conf.beat_schedule["compute-eval-scores-weekly"]
    assert entry["task"] == "liffy.compute_eval_scores"


def test_beat_schedule_is_weekly_on_a_fixed_clock() -> None:
    """A ``crontab``, not a ``timedelta``.

    A timedelta is relative to the last run and re-anchors on every beat
    restart, so on a project under active development "weekly" becomes
    "whenever" — and the persisted series §8.1's trend depends on ends up
    unevenly spaced.
    """
    schedule = celery.conf.beat_schedule["compute-eval-scores-weekly"]["schedule"]

    assert isinstance(schedule, crontab)
    assert schedule.hour == {3}
    assert schedule.minute == {0}
    assert schedule.day_of_week == {1}  # Monday


def test_timezone_is_utc() -> None:
    """Without this the crontab above means whatever the host thinks 03:00 is."""
    assert celery.conf.timezone == "UTC"
    assert celery.conf.enable_utc is True


def test_the_scheduled_task_name_matches_a_real_task() -> None:
    """Ties the schedule's string to the actual @celery.task name.

    These are two independent literals in two files; a typo in either is
    exactly the unregistered-task failure, and nothing else would catch it.
    """
    import app.workers.eval_worker  # noqa: F401  (registers the task)

    scheduled = celery.conf.beat_schedule["compute-eval-scores-weekly"]["task"]
    assert scheduled in celery.tasks
