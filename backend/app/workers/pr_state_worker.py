"""Re-sync pull request state from GitHub (#279).

`pull_requests.status` used to be written exactly once, by `ensure_repo_and_pr`
at review time — when the pull request was open by definition — and never
again. Every row stayed `open` forever, which is what made §8.1's severity
calibration audit report two thirds of pull requests unresolved on a repository
where every one of them had merged.

The webhook now handles `closed`, which fixes the future. This fixes the past,
and covers the deliveries that never arrive: a repository connected after the
fact, a webhook that failed while the worker was down, a pull request closed
during an outage. Without it the column is only correct for pull requests that
happened to close while Liffy was listening.

Deliberately does **not** import ``app.main`` — that would pull FastAPI and
every router into the beat and worker processes for nothing. Same reason as
``eval_worker``.
"""

import logging
from collections import defaultdict

from sqlalchemy import or_, select

from app.database import SessionLocal
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.user import User
from app.services.github_service import (
    GitHubAuthError,
    GitHubClient,
    GitHubRateLimitError,
    parse_github_timestamp,
)
from app.workers.celery_app import celery

logger = logging.getLogger(__name__)


@celery.task(name="liffy.sync_pull_request_state")
def sync_pull_request_state_task(include_closed: bool = False) -> dict:
    """Refresh `status` and `merged_at` for every pull request not known closed.

    Beat passes no arguments, so the scheduled run is the narrow one.

    **Bounded by `status != "closed"` by default.** A closed pull request does
    not reopen without a `reopened` delivery, which is already reviewable and
    re-syncs on its way through `ensure_repo_and_pr`. Re-fetching them would
    turn a sweep proportional to open work into one proportional to the entire
    history of the repository, for no new information.

    ``include_closed=True`` widens it to rows that are already closed but carry
    no ``merged_at`` — the one-shot correction for history. Those rows predate
    the column, so their null means *unknown*, which is indistinguishable on
    screen from the null that means *closed without merging*. That ambiguity is
    exactly what the column exists to remove, so it has to be resolved once,
    from GitHub, rather than assumed either way.

    It is not the default and must not become it: after the correction runs, an
    abandoned pull request keeps a legitimately null ``merged_at`` forever, and
    a daily job that kept re-asking about those would never converge.

    **Idempotent.** Two runs in a row must not change the numbers or the row
    count. There is nothing to upsert here — it writes the same two values it
    read from GitHub — but the counts have to come out the same, which is what
    the test pins.

    Grouped by repository so one `GitHubClient` serves all of that repo's pull
    requests, and so a repository whose owner has no token is skipped once
    rather than once per pull request.

    Returns ``{"synced": n, "skipped": n, "failed": n}``. Celery stores it in
    the result backend, and it is the only way to tell a working job from a
    silently-empty one — a run that synced nothing and a run that found nothing
    to sync look identical without it.
    """
    db = SessionLocal()
    try:
        scope = PullRequest.status != "closed"
        if include_closed:
            scope = or_(scope, PullRequest.merged_at.is_(None))

        rows = db.execute(
            select(PullRequest, Repository.full_name, Repository.user_id)
            .join(Repository, PullRequest.repo_id == Repository.id)
            .where(scope)
        ).all()

        by_repo: dict[tuple[str, object], list[PullRequest]] = defaultdict(list)
        for pr, full_name, user_id in rows:
            by_repo[(full_name, user_id)].append(pr)

        synced = skipped = failed = 0

        for (full_name, user_id), prs in by_repo.items():
            owner_user = db.get(User, user_id)
            token = getattr(owner_user, "github_access_token", None)
            if not token:
                # A disconnected account is an ordinary state, not an error.
                # Raising here would abort the sweep for every other user
                # because one person revoked their token.
                logger.info(
                    "skipping %s: owner has no GitHub token (%d pull request(s))",
                    full_name,
                    len(prs),
                )
                skipped += len(prs)
                continue

            if "/" not in full_name:
                logger.warning("skipping malformed repository name: %r", full_name)
                skipped += len(prs)
                continue

            owner, repo_name = full_name.split("/", 1)

            # A context manager, like every other construction site
            # (`api/repos.py`, `api/reviews.py`, and `review_worker`'s
            # `finally: gh.close()`). Constructed per repository inside a loop,
            # an unclosed client leaks its httpx connection pool until GC gets
            # to it — one pool and its sockets per connected repository, every
            # single run.
            with GitHubClient(token=token) as gh:
                for index, pr in enumerate(prs):
                    try:
                        meta = gh.get_pull_request(
                            owner, repo_name, pr.github_pr_number
                        )
                        pr.status = meta.state or pr.status
                        # Written unconditionally, unlike the re-review path:
                        # here a null is GitHub's answer rather than an absent
                        # field, and a null `merged_at` on a closed pull request
                        # is exactly the "closed without merging" case this
                        # column exists to record.
                        pr.merged_at = parse_github_timestamp(meta.merged_at)
                        db.commit()
                        synced += 1
                    except (GitHubRateLimitError, GitHubAuthError) as exc:
                        # Not per-pull-request problems — they are properties of
                        # the *token*, so every remaining pull request on it
                        # would fail the same way. Continuing would burn a
                        # request and a full stack trace each, report N
                        # independent failures for one cause, and on a secondary
                        # rate limit keep hammering an endpoint that is already
                        # telling us to stop.
                        #
                        # Abandon this repository, count the rest as skipped
                        # rather than failed, and let the next token proceed.
                        db.rollback()
                        remaining = len(prs) - index
                        logger.warning(
                            "abandoning %s after %s: %d pull request(s) skipped",
                            full_name,
                            type(exc).__name__,
                            remaining,
                        )
                        skipped += remaining
                        break
                    except Exception:
                        # A deleted repository, a single revoked scope, a
                        # transient 5xx. One bad pull request must not cost the
                        # whole run, and the next one still gets synced.
                        db.rollback()
                        logger.exception(
                            "state sync failed for %s#%s",
                            full_name,
                            pr.github_pr_number,
                        )
                        failed += 1

        logger.info(
            "pull request state sync: %d synced, %d skipped, %d failed",
            synced,
            skipped,
            failed,
        )
        return {"synced": synced, "skipped": skipped, "failed": failed}
    finally:
        db.close()


def enqueue_pr_state_sync(include_closed: bool = False) -> None:
    """Fire the job now, mirroring ``enqueue_eval_scores``.

    Waiting until the next scheduled run to find out whether the job works is
    not a debugging strategy — and on a first deploy ``include_closed=True`` is
    the call that resolves the pre-#279 rows whose null ``merged_at`` means
    "never asked" rather than "never merged". Tests monkeypatch this rather
    than Celery.
    """
    sync_pull_request_state_task.delay(include_closed=include_closed)
