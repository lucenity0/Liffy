import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from conftest import seed_user
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api import webhook as webhook_api
from app.config import settings
from app.database import Base, get_db
from app.main import app
from app.models.repository import Repository

WEBHOOK_SECRET = "test-webhook-secret"

client = TestClient(app)


@pytest.fixture(autouse=True)
def _fixed_webhook_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pin the secret so the test does not depend on the ambient .env value.
    monkeypatch.setattr(settings, "github_webhook_secret", WEBHOOK_SECRET)


@pytest.fixture(autouse=True)
def connected_repo():
    """A connected octo/demo, since the webhook now ignores unknown repos.

    Autouse so every existing test keeps its original meaning: the deliveries
    they assert on are for a repository somebody has actually connected.
    """
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)

    with factory() as db:
        user = seed_user(db, github_id=1, username="octo")
        db.add(Repository(user_id=user.id, github_repo_id=9, full_name="octo/demo"))
        db.commit()

    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    yield factory
    app.dependency_overrides.clear()


@pytest.fixture()
def enqueued(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, int, str]]:
    # `received_at` has no default here on purpose: this is the one caller that
    # must always supply it, so a webhook that stops passing it fails loudly
    # rather than silently recording NULL for §8.1.
    calls: list[tuple[str, str, int, str]] = []
    monkeypatch.setattr(
        webhook_api.review_worker,
        "enqueue_review",
        lambda owner, repo, pr, received_at: calls.append((owner, repo, pr, received_at)),
    )
    return calls


def _signature(secret: str, body: bytes) -> str:
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def _signed(body: bytes) -> "httpx.Response":
    return client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-Hub-Signature-256": _signature(WEBHOOK_SECRET, body),
            "Content-Type": "application/json",
        },
    )


def _post(payload: dict) -> "httpx.Response":
    body = json.dumps(payload).encode("utf-8")
    return client.post(
        "/webhook/github",
        content=body,
        headers={
            "X-Hub-Signature-256": _signature(WEBHOOK_SECRET, body),
            "Content-Type": "application/json",
        },
    )


PR_OPENED = {
    "action": "opened",
    "pull_request": {"number": 7},
    "repository": {"full_name": "octo/demo"},
}


def test_webhook_rejects_invalid_signature(enqueued) -> None:
    response = client.post("/webhook/github", json=PR_OPENED)
    assert response.status_code == 401
    assert enqueued == []


def test_webhook_queues_review_on_pr_opened(enqueued) -> None:
    response = _post(PR_OPENED)
    assert response.status_code == 200
    assert response.json() == {"status": "queued", "pr_number": 7}
    assert [call[:3] for call in enqueued] == [("octo", "demo", 7)]


def _seed_pr(factory, *, auto_review: bool, repo_id=None) -> None:
    """A pull request Liffy has already seen, with the toggle set.

    Takes the factory rather than reaching for it: the fixture yields it, so
    a test that needs this has to request `connected_repo` and say so.
    """
    from app.models.pull_request import PullRequest

    with factory() as db:
        db.add(
            PullRequest(
                repo_id=repo_id or db.scalar(select(Repository.id)),
                github_pr_number=7, title="t", author="a",
                base_branch="main", head_branch="f", status="open",
                auto_review=auto_review,
            )
        )
        db.commit()


def test_a_push_is_ignored_unless_the_pull_request_opted_in(
    connected_repo, enqueued
) -> None:
    """`synchronize` fires on every push.

    Applying three of Liffy's own suggestions used to cost three full reviews,
    and a two-line README commit cost the same as a real change — quota spent
    without anyone asking for it.
    """
    _seed_pr(connected_repo, auto_review=False)

    response = _post(dict(PR_OPENED, action="synchronize"))

    assert response.json()["status"] == "ignored"
    assert enqueued == []


def test_a_push_queues_when_the_pull_request_opted_in(
    connected_repo, enqueued
) -> None:
    _seed_pr(connected_repo, auto_review=True)

    response = _post(dict(PR_OPENED, action="synchronize"))

    assert response.json()["status"] == "queued"
    assert len(enqueued) == 1


def test_a_push_on_a_pull_request_liffy_has_never_seen_is_ignored(enqueued) -> None:
    """No row means off, which is the same answer as the column default."""
    response = _post(dict(PR_OPENED, action="synchronize"))

    assert response.json()["status"] == "ignored"
    assert enqueued == []


def test_opening_a_pull_request_still_reviews_it_unasked(enqueued) -> None:
    """The one case where an unrequested review is the whole point.

    The toggle governs what happens *after* the first review, and is opted out
    of rather than into — so a pull request nobody has looked at is still
    looked at.
    """
    response = _post(PR_OPENED)

    assert response.json()["status"] == "queued"
    assert len(enqueued) == 1


def test_reopening_is_not_gated_either(enqueued) -> None:
    response = _post(dict(PR_OPENED, action="reopened"))

    assert response.json()["status"] == "queued"
    assert len(enqueued) == 1


def test_webhook_malformed_json_returns_400(enqueued) -> None:
    # Valid signature but non-JSON body must not 500 (which GitHub would retry).
    response = _signed(b"not json at all")
    assert response.status_code == 400
    assert enqueued == []


def test_webhook_ignores_irrelevant_events(enqueued) -> None:
    for payload in (
        {},  # ping-like
        # `labeled`, not `closed`: closed is neither reviewable nor irrelevant
        # any more — it is how Liffy learns the pull request finished, and it
        # has its own tests below.
        dict(PR_OPENED, action="labeled"),  # non-reviewable, non-state action
        {"action": "opened", "pull_request": {"number": 7}},  # no repository
    ):
        response = _post(payload)
        assert response.status_code == 200
        assert response.json() == {"status": "ignored"}
    assert enqueued == []


def test_webhook_still_works_without_auth(enqueued) -> None:
    """GitHub cannot present a JWT; HMAC is this route's authentication.

    Requiring a bearer token here would break every real delivery.
    """
    response = _post(PR_OPENED)

    assert response.status_code == 200
    assert "authorization" not in {k.lower() for k in response.request.headers}
    assert [call[:3] for call in enqueued] == [("octo", "demo", 7)]


def test_webhook_for_unknown_repo_is_ignored(enqueued) -> None:
    """A delivery for a repository nobody connected has no owner.

    Before AUTH-4 a phantom system user absorbed these, so an unsolicited
    webhook could create rows in the database.
    """
    response = _post(dict(PR_OPENED, repository={"full_name": "stranger/unknown"}))

    assert response.status_code == 200
    assert response.json()["status"] == "ignored"
    assert enqueued == []


# ── §8.1 receipt timestamp (METRIC-2) ────────────────────────────────────────


def test_webhook_passes_received_at_to_enqueue(enqueued) -> None:
    """Report §8.1 measures from here, so the stamp has to leave the API.

    Without it the worker has no way to know when the delivery arrived, and
    the < 90s target stays unmeasurable no matter what the pipeline records.
    """
    response = _post(PR_OPENED)

    assert response.status_code == 200
    assert enqueued, "webhook did not enqueue"
    assert enqueued[0][3] is not None


def test_received_at_is_an_iso_utc_string(enqueued) -> None:
    """A ``datetime`` would fail at ``.delay()``, not at execution.

    ``celery_app`` sets ``task_serializer="json"``, so the failure surfaces as
    a broker error and reads like infrastructure rather than like this line.
    Pinning the type at the boundary the webhook owns is cheaper than
    debugging that.
    """
    _post(PR_OPENED)
    stamp = enqueued[0][3]

    assert isinstance(stamp, str)
    assert datetime.fromisoformat(stamp).utcoffset() == timedelta(0)


def test_received_at_is_close_to_now(enqueued) -> None:
    """Catches a naive ``datetime.now()``, which nothing else here would.

    A naive stamp still parses, still round-trips, and still satisfies every
    other assertion in this file — it is simply wrong by the host's UTC
    offset. On this machine that is 5.5 hours, recorded as queue wait.
    """
    _post(PR_OPENED)
    parsed = datetime.fromisoformat(enqueued[0][3])

    assert abs(datetime.now(timezone.utc) - parsed) < timedelta(seconds=5)


def test_ignored_events_do_not_enqueue(enqueued) -> None:
    """A ping is stamped — into a local that is then discarded.

    The observable claim is that nothing reaches the queue, not that no clock
    was read, so that is what is asserted.
    """
    _post({})
    _post(dict(PR_OPENED, action="closed"))

    assert enqueued == []


def test_the_gate_reads_the_flag_of_the_repository_the_review_belongs_to(
    connected_repo, enqueued
) -> None:
    """`full_name` has no unique constraint.

    Two users can connect the same repository, and each connection gets its
    own `Repository` and `PullRequest` rows. `resolve_repo_owner` picks the
    earliest-connected one; the gate has to read *that* connection's flag.

    The rows are arranged so the two disagree: the second connector's pull
    request row is inserted **first**, so an unscoped `db.scalar` — which has
    no ORDER BY and returns rows in insertion order — reads its `False` and
    refuses a review the actual owner asked for. Without that arrangement the
    test passes whether the bug is present or not.
    """
    from app.models.pull_request import PullRequest

    with connected_repo() as db:
        owner_repo_id = db.scalar(select(Repository.id))

        # Connected later, so `resolve_repo_owner` does *not* pick this one.
        stranger = seed_user(db, github_id=2, username="hubot")
        second = Repository(
            user_id=stranger.id,
            github_repo_id=9,
            full_name="octo/demo",
            created_at=datetime.now(timezone.utc) + timedelta(days=1),
        )
        db.add(second)
        db.flush()

        # ...but its pull request row goes in first.
        db.add(
            PullRequest(
                repo_id=second.id, github_pr_number=7, title="t", author="a",
                base_branch="main", head_branch="f", status="open",
                auto_review=False,
            )
        )
        db.flush()
        db.add(
            PullRequest(
                repo_id=owner_repo_id, github_pr_number=7, title="t", author="a",
                base_branch="main", head_branch="f", status="open",
                auto_review=True,
            )
        )
        db.commit()

    response = _post(dict(PR_OPENED, action="synchronize"))

    assert response.json()["status"] == "queued"
    assert len(enqueued) == 1


# ── `closed` re-syncs state without reviewing (#279) ─────────────────────────


def _closed(*, merged_at: str | None, number: int = 7) -> dict:
    return {
        "action": "closed",
        "pull_request": {
            "number": number,
            "state": "closed",
            "merged": merged_at is not None,
            "merged_at": merged_at,
        },
        "repository": {"full_name": "octo/demo"},
    }


def _fetch_pr(factory, number: int = 7):
    from app.models.pull_request import PullRequest

    with factory() as db:
        return db.scalar(
            select(PullRequest).where(PullRequest.github_pr_number == number)
        )


def test_a_merged_pull_request_is_recorded_as_closed_and_merged(
    connected_repo, enqueued
) -> None:
    """The transition nothing was listening for.

    `pull_requests.status` was written once, at review time, when the pull
    request was open by definition — and never again. Every row stayed `open`
    forever, which is what made the calibration audit report two thirds of
    pull requests unresolved on a repository where all of them had merged.
    """
    _seed_pr(connected_repo, auto_review=False)

    response = _post(_closed(merged_at="2026-08-21T18:39:30Z"))

    assert response.status_code == 200
    assert response.json() == {"status": "state-synced", "pr_number": 7}

    pr = _fetch_pr(connected_repo)
    assert pr is not None
    assert pr.status == "closed"
    assert pr.merged_at is not None
    assert pr.merged_at.year == 2026 and pr.merged_at.month == 8


def test_a_pull_request_closed_without_merging_leaves_merged_at_null(
    connected_repo, enqueued
) -> None:
    """The distinction the column exists to carry.

    GitHub's `state` is `closed` either way. A null `merged_at` on a closed
    pull request is what says it was abandoned rather than shipped — so it is
    written, not skipped.
    """
    _seed_pr(connected_repo, auto_review=False)

    _post(_closed(merged_at=None))

    pr = _fetch_pr(connected_repo)
    assert pr is not None
    assert pr.status == "closed"
    assert pr.merged_at is None


def test_closing_a_pull_request_does_not_queue_a_review(
    connected_repo, enqueued
) -> None:
    """A pull request closing is not a reason to review it.

    Reviewing on `closed` would bill a full review — tokens, and on a
    subscription rate-limit quota — to comment on a pull request nobody can act
    on any more.
    """
    _seed_pr(connected_repo, auto_review=True)

    _post(_closed(merged_at="2026-08-21T18:39:30Z"))

    assert enqueued == []


def test_closing_an_untracked_pull_request_creates_no_row(
    connected_repo, enqueued
) -> None:
    """**Update only, never create.**

    A `closed` delivery for a pull request Liffy has never reviewed must not
    conjure a `PullRequest` row. That is the AUTH-4 phantom-row failure the
    `resolve_repo_owner` guard exists to prevent, and here it would also poison
    the *denominator* of every rate on the calibration table by adding pull
    requests that carry no comments at all.
    """
    from app.models.pull_request import PullRequest

    response = _post(_closed(merged_at="2026-08-21T18:39:30Z", number=999))

    assert response.status_code == 200
    assert response.json()["status"] == "ignored"

    with connected_repo() as db:
        assert db.scalars(select(PullRequest)).all() == []
    assert enqueued == []


def test_closing_a_pull_request_on_an_unconnected_repo_is_ignored(enqueued) -> None:
    """Same guard as every other delivery: no owner, no rows."""
    payload = _closed(merged_at=None)
    payload["repository"]["full_name"] = "stranger/unknown"

    response = _post(payload)

    assert response.status_code == 200
    assert response.json()["reason"] == "repository not connected"


def test_a_malformed_merge_timestamp_costs_the_date_not_the_sync(
    connected_repo, enqueued
) -> None:
    """The close still records. One bad field must not lose the transition."""
    _seed_pr(connected_repo, auto_review=False)

    payload = _closed(merged_at="not-a-timestamp")
    _post(payload)

    pr = _fetch_pr(connected_repo)
    assert pr is not None
    assert pr.status == "closed"
    assert pr.merged_at is None


def test_reopening_syncs_state_and_still_queues_the_review(
    connected_repo, enqueued
) -> None:
    """`reopened` is in both action sets, and both halves have to happen.

    Returning early after the state sync — the obvious way to add `reopened` —
    would swallow the review it is supposed to trigger. A reopened pull request
    is one nobody has looked at in its new form, which is the case an
    unrequested review exists for.
    """
    _seed_pr(connected_repo, auto_review=False)
    _post(_closed(merged_at=None))  # close it first
    assert _fetch_pr(connected_repo).status == "closed"

    response = _post({
        "action": "reopened",
        "pull_request": {"number": 7, "state": "open", "merged_at": None},
        "repository": {"full_name": "octo/demo"},
    })

    assert response.json() == {"status": "queued", "pr_number": 7}
    assert [c[:3] for c in enqueued] == [("octo", "demo", 7)]
    # ...and the row no longer claims to be closed, without waiting for the
    # worker to get there.
    assert _fetch_pr(connected_repo).status == "open"


def test_a_reopened_row_is_corrected_even_if_the_review_never_runs(
    connected_repo, enqueued
) -> None:
    """The hole this closes.

    If the broker is down or `run_review` raises before `ensure_repo_and_pr`,
    the row keeps the `closed` written when it closed — and the daily sweep
    scopes itself to `status != "closed"`, so the one job that fixes wrong rows
    cannot see it. The webhook write is what makes that unreachable.
    """
    _seed_pr(connected_repo, auto_review=False)
    _post(_closed(merged_at="2026-08-21T18:39:30Z"))

    _post({
        "action": "reopened",
        "pull_request": {"number": 7, "state": "open", "merged_at": None},
        "repository": {"full_name": "octo/demo"},
    })

    pr = _fetch_pr(connected_repo)
    assert pr.status == "open"          # visible to the sweep again
    assert pr.merged_at is None         # and no longer claiming a merge


def test_a_non_string_merge_timestamp_does_not_500_the_webhook(
    connected_repo, enqueued
) -> None:
    """The route is unauthenticated by design and GitHub retries 5xx.

    `parse_github_timestamp` promises to return None on anything unparseable;
    a payload whose `merged_at` is a number would otherwise raise
    AttributeError inside it and surface as an unhandled 500.
    """
    _seed_pr(connected_repo, auto_review=False)

    response = _post({
        "action": "closed",
        "pull_request": {"number": 7, "state": "closed", "merged_at": 1755800000},
        "repository": {"full_name": "octo/demo"},
    })

    assert response.status_code == 200
    pr = _fetch_pr(connected_repo)
    assert pr.status == "closed"
    assert pr.merged_at is None
