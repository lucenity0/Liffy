"""Weekly evaluation snapshot (report §8.2, bullets 2 and 3).

    A weekly Celery beat job computes eval_scores for all completed reviews.
    Reviews with approval rate below 50% are flagged for manual inspection.

``GET /reviews/{id}/eval`` computes the same numbers live on request; this is
what makes them a persisted time series, which is the only way §8.1's
"tracked as trend" targets can ever be checked.

Deliberately does **not** import ``app.main`` — that would pull FastAPI and
every router into the beat and worker processes for nothing.
"""

import logging

from sqlalchemy import select

from app.database import SessionLocal
from app.models.eval_score import EvalScore
from app.models.review import Review
from app.services.eval_service import LOW_APPROVAL_THRESHOLD, compute_review_scores
from app.workers.celery_app import celery

logger = logging.getLogger(__name__)


@celery.task(name="liffy.compute_eval_scores")
def compute_eval_scores_task() -> dict:
    """Score every completed review and upsert one ``eval_scores`` row each.

    Takes no arguments — beat passes none.

    **Idempotent.** Running it twice in a row must not change the numbers or
    the row count; that is what the upsert is for, and what
    ``test_rerunning_updates_rather_than_duplicates`` pins.

    Returns ``{"scored": n, "skipped": n, "failed": n}``. Celery stores it in
    the result backend, and it is the only way to tell a working job from a
    silently-empty one — a run that scored nothing and a run that found nothing
    to score look identical without it.
    """
    db = SessionLocal()
    try:
        review_ids = list(
            db.scalars(select(Review.id).where(Review.status == "completed"))
        )

        scored = skipped = failed = 0
        for review_id in review_ids:
            try:
                scores = compute_review_scores(db, review_id)

                # `None` scores means the review was deleted between the id
                # query above and now — a real race on a long run. `None`
                # *rates* means no feedback, which is the branch below.
                if scores is None or scores.approval_rate is None:
                    skipped += 1
                    continue

                flagged = scores.approval_rate < LOW_APPROVAL_THRESHOLD

                row = db.scalar(
                    select(EvalScore).where(EvalScore.review_id == review_id)
                )
                if row is None:
                    row = EvalScore(review_id=review_id)
                    db.add(row)
                row.approval_rate = scores.approval_rate
                row.false_positive_rate = scores.false_positive_rate
                row.flagged = flagged
                db.commit()
                scored += 1

                if flagged:
                    # This is a two-person project with no alerting. The log is
                    # the notification, so it goes out at `warning` with the
                    # two things needed to act on it.
                    logger.warning(
                        "review %s flagged for manual inspection: approval rate %.2f",
                        review_id,
                        scores.approval_rate,
                    )
            except Exception:
                # One bad review must not cost the whole run. A review deleted
                # mid-run is the expected case; anything else is worth the
                # traceback, and the next review still gets scored.
                db.rollback()
                logger.exception("scoring failed for review %s", review_id)
                failed += 1

        return {"scored": scored, "skipped": skipped, "failed": failed}
    finally:
        db.close()


def enqueue_eval_scores() -> None:
    """Fire the job now, mirroring ``enqueue_review``.

    Waiting until Monday to find out whether the job works is not a debugging
    strategy. Tests monkeypatch this rather than Celery.
    """
    compute_eval_scores_task.delay()
