import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.user import User
from app.services.github_service import parse_github_timestamp, verify_webhook_signature
from app.services.review_service import resolve_repo_owner
from app.workers import review_worker

router = APIRouter()

# PR events that warrant a (re-)review (report §3.1 step 02).
_REVIEWABLE_ACTIONS = {"opened", "synchronize", "reopened"}

# PR events that carry a state change worth recording.
#
# `reopened` is in both this set and the reviewable one, deliberately. It does
# go through `ensure_repo_and_pr` on the review path, which re-syncs `status` —
# but only if the review actually runs. If the broker is down, or `run_review`
# raises before it reaches `ensure_repo_and_pr` (`gh.get_pull_request` is
# called first and can 5xx or hit a rate limit), the row keeps the `closed`
# this webhook wrote when it closed. And nothing ever corrects it: the daily
# sweep scopes itself to `status != "closed"`, so a wrongly-closed row is
# invisible to the one job that exists to fix wrong rows.
#
# Syncing here as well costs one write and closes that hole. The write is
# idempotent with the one `ensure_repo_and_pr` makes later, so the redundancy
# is the point rather than a cost.
_STATE_ACTIONS = {"closed", "reopened"}


# Deliberately unauthenticated: GitHub cannot present a JWT. This route is
# authenticated by HMAC signature instead, which is the correct mechanism for
# it — requiring a bearer token would break every real webhook delivery.
@router.post("/github")
async def github_webhook(
    request: Request,
    x_hub_signature_256: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict[str, str | int]:
    body = await request.body()
    if not verify_webhook_signature(settings.github_webhook_secret, body, x_hub_signature_256):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid signature")

    # Report §8.1's clock starts here — the "webhook received" its < 90s target
    # is measured from. The placement is load-bearing in both directions:
    # earlier would include a slow client's upload, letting anyone deflate the
    # metric by trickling a body; later would hide the JSON parse and the
    # `resolve_repo_owner` round trip, which are real work a user waits through.
    #
    # `timezone.utc` explicitly — a naive `datetime.now()` records the API
    # host's offset as latency, and the worker reading it is a different process
    # that may not share the host.
    received_at = datetime.now(timezone.utc)

    try:
        payload = json.loads(body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        # Signature was valid but the body is malformed: return 4xx so GitHub
        # records a client error instead of retrying on a 500.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Malformed JSON body"
        ) from exc
    pull_request = payload.get("pull_request")
    action = payload.get("action")
    full_name = (payload.get("repository") or {}).get("full_name", "")

    if not pull_request or "/" not in full_name:
        # 200 so GitHub does not retry pings/irrelevant events.
        return {"status": "ignored"}

    if action not in _REVIEWABLE_ACTIONS and action not in _STATE_ACTIONS:
        return {"status": "ignored"}

    # A delivery for a repository nobody connected has no owner to attribute the
    # review to. Ignored rather than absorbed by a phantom user (AUTH-4), which
    # let an unsolicited webhook create rows. Checked here rather than in the
    # worker so the work is never queued.
    owner_user = resolve_repo_owner(db, full_name)
    if owner_user is None:
        return {"status": "ignored", "reason": "repository not connected"}

    owner, repo_name = full_name.split("/", 1)
    pr_number = int(pull_request["number"])

    # A pull request closing is not a reason to review it, but it is the only
    # moment Liffy is ever told the state changed.
    #
    # Without this branch `pull_requests.status` is written once — by
    # `ensure_repo_and_pr` at review time, when the pull request was open by
    # definition — and never again. Every row stays `open` forever, which is
    # what made the §8.1 calibration audit report two thirds of pull requests
    # unresolved on a repository where every one of them had merged.
    #
    # Recorded first, then the review decision below. A state action that is
    # *also* reviewable (`reopened`) must not return here — that would swallow
    # the review it is supposed to trigger.
    if action in _STATE_ACTIONS:
        synced = _sync_pr_state(db, owner_user, full_name, pr_number, pull_request)
        if action not in _REVIEWABLE_ACTIONS:
            return synced

    # A push only reviews if somebody asked it to.
    #
    # `synchronize` fires on *every* push, so applying three of Liffy's own
    # suggestions used to cost three full reviews, and a two-line README commit
    # cost the same as a real change. On a subscription that is rate-limit
    # quota spent without anyone asking for it.
    #
    # `opened` and `reopened` are not gated: a pull request nobody has looked
    # at yet is the one case where an unrequested review is the whole point,
    # and it is what the toggle below is opted *out* of rather than into.
    if action == "synchronize" and not _auto_review_enabled(
        db, owner_user, full_name, pr_number
    ):
        return {"status": "ignored", "reason": "auto-review off for this pull request"}

    review_worker.enqueue_review(owner, repo_name, pr_number, received_at.isoformat())
    return {"status": "queued", "pr_number": pr_number}


def _auto_review_enabled(
    db: Session, owner: User, full_name: str, pr_number: int
) -> bool:
    """Whether this pull request opted into being reviewed on every push.

    Scoped to the *owner* and not just to `full_name`, because `full_name` has
    no unique constraint: nothing stops two users connecting the same
    repository, and each connection gets its own `Repository` row and its own
    `PullRequest` rows. Filtering on the name alone lets an arbitrary one win,
    so the gate could read one user's flag while the review it gates belongs
    to another's.

    `resolve_repo_owner` has already picked which connection this delivery
    belongs to — first connector wins — so reusing its answer is what keeps
    the gate and the enqueue talking about the same row.

    A pull request Liffy has never seen has no row, and no row means off —
    the same answer as the column's default, so it needs no special case.
    """
    return bool(
        db.scalar(
            select(PullRequest.auto_review)
            .join(Repository, PullRequest.repo_id == Repository.id)
            .where(
                Repository.user_id == owner.id,
                Repository.full_name == full_name,
                PullRequest.github_pr_number == pr_number,
            )
        )
    )


def _sync_pr_state(
    db: Session,
    owner: User,
    full_name: str,
    pr_number: int,
    payload: dict,
) -> dict[str, str | int]:
    """Record that a pull request closed, and whether it merged.

    **Updates an existing row; never creates one.** A `closed` delivery for a
    pull request Liffy has never reviewed must not conjure a `PullRequest` row
    — that is the AUTH-4 phantom-row failure the `resolve_repo_owner` guard
    above exists to prevent, and here it would additionally poison the
    *denominator* of every rate on the calibration table by adding pull
    requests that carry no comments at all.

    Scoped to the owner for the same reason `_auto_review_enabled` is: nothing
    stops two users connecting the same repository, and each connection has its
    own rows.

    No API call. GitHub's `pull_request.closed` payload already carries both
    `state` and `merged_at`, so asking it again would spend a rate-limit unit
    to learn what is in the request body.
    """
    pr = db.scalar(
        select(PullRequest)
        .join(Repository, PullRequest.repo_id == Repository.id)
        .where(
            Repository.user_id == owner.id,
            Repository.full_name == full_name,
            PullRequest.github_pr_number == pr_number,
        )
    )
    if pr is None:
        return {"status": "ignored", "reason": "pull request not tracked"}

    pr.status = payload.get("state") or "closed"
    # Only when it merged. `merged_at` is null on a close-without-merge, and
    # that null is the whole distinction this column exists to carry — so it is
    # written rather than skipped, unlike the re-review path where a null means
    # "GitHub did not say".
    pr.merged_at = parse_github_timestamp(payload.get("merged_at"))
    db.commit()

    return {"status": "state-synced", "pr_number": pr_number}
