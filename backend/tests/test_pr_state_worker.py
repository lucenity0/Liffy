"""The daily pull request state sweep (#279).

The task function is called **directly**, never through a running Celery
worker — the same pattern ``test_eval_worker.py`` and ``test_workers.py`` use.
A test that needs a broker is a test that fails for reasons unrelated to the
code under it.

`GitHubClient` is monkeypatched at the name the worker imported, not at
`github_service`: the worker did `from ... import GitHubClient`, so patching
the source module rebinds a name nothing looks at any more.
"""

import pytest
from conftest import seed_user
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.services.github_service import (
    GitHubAuthError,
    GitHubRateLimitError,
    PullRequestMeta,
)
from app.workers import pr_state_worker

_seq = iter(range(1000, 9000))


@pytest.fixture()
def factory(monkeypatch):
    engine = create_engine(
        "sqlite://", future=True, connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setattr(pr_state_worker, "SessionLocal", sessions)
    return sessions


def _seed(factory, *, token: str | None = "gho_token", status: str = "open",
          number: int = 7, full_name: str = "octo/demo") -> None:
    with factory() as db:
        user = seed_user(db, github_id=next(_seq), username=f"u{next(_seq)}")
        user.github_access_token = token
        db.flush()
        repo = Repository(
            user_id=user.id, github_repo_id=next(_seq), full_name=full_name
        )
        db.add(repo)
        db.flush()
        db.add(
            PullRequest(
                repo_id=repo.id, github_pr_number=number, title="t", author="a",
                base_branch="main", head_branch="f", status=status,
            )
        )
        db.commit()


class _FakeClient:
    """Answers every PR with one canned meta, and counts the calls."""

    calls: list[tuple[str, str, int]] = []

    closed = 0

    def __init__(self, meta: PullRequestMeta | None = None, raises: bool = False,
                 raises_exc: BaseException | None = None):
        self._meta = meta
        self._raises = raises
        self._raises_exc = raises_exc

    def get_pull_request(self, owner, repo, number) -> PullRequestMeta:
        type(self).calls.append((owner, repo, number))
        if self._raises_exc is not None:
            raise self._raises_exc
        if self._raises:
            raise RuntimeError("404 from GitHub")
        return self._meta

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        type(self).closed += 1


def _patch_client(monkeypatch, meta=None, raises=False, raises_exc=None):
    _FakeClient.calls = []
    _FakeClient.closed = 0
    monkeypatch.setattr(
        pr_state_worker, "GitHubClient",
        lambda token: _FakeClient(meta=meta, raises=raises, raises_exc=raises_exc),
    )


MERGED = PullRequestMeta(
    number=7, title="t", author="a", base_branch="main", head_branch="f",
    head_sha="abc", state="closed", merged_at="2026-08-21T18:39:30Z",
)
ABANDONED = PullRequestMeta(
    number=7, title="t", author="a", base_branch="main", head_branch="f",
    head_sha="abc", state="closed", merged_at=None,
)


def test_a_merged_pull_request_stops_reading_as_open(factory, monkeypatch) -> None:
    """The whole point of the sweep.

    Webhooks only fix the future — no `closed` delivery will ever arrive for a
    pull request that merged last month, and every row in the database today
    is in exactly that state.
    """
    _seed(factory)
    _patch_client(monkeypatch, meta=MERGED)

    result = pr_state_worker.sync_pull_request_state_task()

    assert result == {"synced": 1, "skipped": 0, "failed": 0}
    with factory() as db:
        pr = db.scalar(select(PullRequest))
        assert pr.status == "closed"
        assert pr.merged_at is not None


def test_a_closed_unmerged_pull_request_keeps_a_null_merge_date(
    factory, monkeypatch
) -> None:
    """Written unconditionally, unlike the re-review path: here a null is
    GitHub's answer rather than an absent field, and a null `merged_at` on a
    closed pull request is the distinction the column exists to record."""
    _seed(factory)
    _patch_client(monkeypatch, meta=ABANDONED)

    pr_state_worker.sync_pull_request_state_task()

    with factory() as db:
        pr = db.scalar(select(PullRequest))
        assert pr.status == "closed"
        assert pr.merged_at is None


def test_already_closed_pull_requests_are_not_refetched(factory, monkeypatch) -> None:
    """Bounded by `status != "closed"`.

    A closed pull request does not reopen without a `reopened` delivery, which
    is already reviewable and re-syncs on its way through `ensure_repo_and_pr`.
    Re-fetching them turns a sweep proportional to open work into one
    proportional to the entire history of the repository.
    """
    _seed(factory, status="closed")
    _patch_client(monkeypatch, meta=MERGED)

    result = pr_state_worker.sync_pull_request_state_task()

    assert _FakeClient.calls == []
    assert result == {"synced": 0, "skipped": 0, "failed": 0}


def test_an_owner_without_a_token_is_skipped_not_raised_on(
    factory, monkeypatch
) -> None:
    """A disconnected account is an ordinary state, not an error.

    Raising here would abort the sweep for every other user because one person
    revoked their token — and the counts have to say it was skipped, not that
    it succeeded.
    """
    _seed(factory, token=None)
    _patch_client(monkeypatch, meta=MERGED)

    result = pr_state_worker.sync_pull_request_state_task()

    assert result == {"synced": 0, "skipped": 1, "failed": 0}
    assert _FakeClient.calls == []


def test_a_github_failure_costs_one_pull_request_not_the_run(
    factory, monkeypatch
) -> None:
    """A deleted repository, a revoked scope, a transient 5xx."""
    _seed(factory)
    _patch_client(monkeypatch, raises=True)

    result = pr_state_worker.sync_pull_request_state_task()

    assert result == {"synced": 0, "skipped": 0, "failed": 1}
    with factory() as db:
        assert db.scalar(select(PullRequest)).status == "open"


def test_one_bad_repository_does_not_stop_the_others(factory, monkeypatch) -> None:
    """Two owners, one with no token. The other still gets synced."""
    _seed(factory, token=None, full_name="broken/repo", number=1)
    _seed(factory, token="gho_ok", full_name="octo/demo", number=7)
    _patch_client(monkeypatch, meta=MERGED)

    result = pr_state_worker.sync_pull_request_state_task()

    assert result == {"synced": 1, "skipped": 1, "failed": 0}
    with factory() as db:
        synced = db.scalar(
            select(PullRequest).where(PullRequest.github_pr_number == 7)
        )
        assert synced.status == "closed"


def test_the_sweep_is_idempotent(factory, monkeypatch) -> None:
    """Two runs in a row must not change the row count or the values.

    There is nothing to upsert here — it writes what it read from GitHub — but
    the second run must find nothing left to do, which is what proves the
    `status != "closed"` bound is actually narrowing rather than the sweep
    happening to be harmless.
    """
    _seed(factory)
    _patch_client(monkeypatch, meta=MERGED)

    first = pr_state_worker.sync_pull_request_state_task()
    second = pr_state_worker.sync_pull_request_state_task()

    assert first == {"synced": 1, "skipped": 0, "failed": 0}
    assert second == {"synced": 0, "skipped": 0, "failed": 0}
    with factory() as db:
        assert len(db.scalars(select(PullRequest)).all()) == 1


def test_an_empty_database_reports_zeroes_rather_than_nothing(
    factory, monkeypatch
) -> None:
    """A run that synced nothing and a run that found nothing to sync look
    identical without the counts — which is why the task returns them."""
    _patch_client(monkeypatch, meta=MERGED)

    assert pr_state_worker.sync_pull_request_state_task() == {
        "synced": 0, "skipped": 0, "failed": 0
    }


# ── the one-shot correction for pre-#279 rows ────────────────────────────────


def test_include_closed_reaches_a_closed_row_with_no_merge_date(
    factory, monkeypatch
) -> None:
    """The ambiguity the column exists to remove, resolved once.

    A row closed before `merged_at` existed carries a null that means "never
    asked". On screen that is indistinguishable from the null that means
    "closed without merging" — so it has to be settled from GitHub rather than
    assumed either way.
    """
    _seed(factory, status="closed")
    _patch_client(monkeypatch, meta=MERGED)

    result = pr_state_worker.sync_pull_request_state_task(include_closed=True)

    assert result == {"synced": 1, "skipped": 0, "failed": 0}
    with factory() as db:
        assert db.scalar(select(PullRequest)).merged_at is not None


def test_include_closed_leaves_a_resolved_row_alone(factory, monkeypatch) -> None:
    """Once a merge date is known, the row is out of scope again.

    This is what keeps the correction one-shot rather than a second daily
    sweep over the whole history.
    """
    _seed(factory, status="closed")
    _patch_client(monkeypatch, meta=MERGED)
    pr_state_worker.sync_pull_request_state_task(include_closed=True)

    second = pr_state_worker.sync_pull_request_state_task(include_closed=True)

    assert second == {"synced": 0, "skipped": 0, "failed": 0}


def test_an_abandoned_pull_request_is_re_asked_only_under_include_closed(
    factory, monkeypatch
) -> None:
    """The reason `include_closed` is not the default.

    A pull request closed without merging keeps a legitimately null
    `merged_at` forever, so it stays in scope of the widened query on every
    run. A daily job carrying that flag would never converge — which is fine
    for a one-shot correction and not fine for a schedule.
    """
    _seed(factory, status="closed")
    _patch_client(monkeypatch, meta=ABANDONED)

    widened = pr_state_worker.sync_pull_request_state_task(include_closed=True)
    narrow = pr_state_worker.sync_pull_request_state_task()

    assert widened == {"synced": 1, "skipped": 0, "failed": 0}
    assert narrow == {"synced": 0, "skipped": 0, "failed": 0}


def test_the_scheduled_run_passes_no_arguments(factory, monkeypatch) -> None:
    """Beat calls the task with none, so the default has to be the narrow one.

    A default of True would put the whole history of every repository into a
    daily sweep, which is the failure this parameter exists to keep optional.
    """
    import inspect

    signature = inspect.signature(pr_state_worker.sync_pull_request_state_task)
    assert signature.parameters["include_closed"].default is False


# ── token-level failures are not per-pull-request failures ───────────────────


@pytest.mark.parametrize(
    "exc", [GitHubRateLimitError("rate limited"), GitHubAuthError("revoked")]
)
def test_a_token_level_failure_abandons_the_repo_and_skips_the_rest(
    factory, monkeypatch, exc
) -> None:
    """Rate limit and auth are properties of the *token*, not of one PR.

    Continuing would burn a request and a full stack trace per remaining pull
    request, report N independent failures for one cause, and — on a secondary
    rate limit — keep hammering an endpoint already asking us to stop.
    """
    _seed(factory, full_name="octo/demo", number=7)
    _seed(factory, full_name="octo/demo2", number=8)
    _patch_client(monkeypatch, raises_exc=exc)

    result = pr_state_worker.sync_pull_request_state_task()

    # One call per repo — it gives up rather than walking the rest.
    assert result["failed"] == 0
    assert result["skipped"] == 2
    assert result["synced"] == 0


def test_a_token_failure_on_one_repo_does_not_stop_the_next(
    factory, monkeypatch
) -> None:
    """Abandon the repository, not the run."""
    _seed(factory, full_name="octo/rate-limited", number=1)
    _seed(factory, full_name="octo/fine", number=7)

    calls: list[str] = []

    class _Selective:
        def __init__(self, token): ...
        def __enter__(self): return self
        def __exit__(self, *_): ...
        def get_pull_request(self, owner, repo, number):
            calls.append(repo)
            if repo == "rate-limited":
                raise GitHubRateLimitError("slow down")
            return MERGED

    monkeypatch.setattr(pr_state_worker, "GitHubClient", _Selective)
    result = pr_state_worker.sync_pull_request_state_task()

    assert "fine" in calls
    assert result["synced"] == 1
    assert result["skipped"] == 1


def test_the_client_is_closed(factory, monkeypatch) -> None:
    """One unclosed client per repository leaks its connection pool until GC.

    Every other construction site in the codebase closes it — `api/repos.py`
    and `api/reviews.py` via `with`, `review_worker` via `finally`.
    """
    _seed(factory)
    _patch_client(monkeypatch, meta=MERGED)

    pr_state_worker.sync_pull_request_state_task()

    assert _FakeClient.closed == 1


def test_the_client_is_closed_even_when_a_pull_request_fails(
    factory, monkeypatch
) -> None:
    _seed(factory)
    _patch_client(monkeypatch, raises=True)

    pr_state_worker.sync_pull_request_state_task()

    assert _FakeClient.closed == 1
