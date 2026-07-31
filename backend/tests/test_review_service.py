import json
import time
import uuid
from datetime import datetime, timedelta, timezone

import chromadb
import pytest
from conftest import (
    DeterministicEmbeddings,
    FakeGitHub,
    FakeLLM,
    seed_user,
    shared_chroma_client,
)
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

import app.models  # noqa: F401
from app.database import Base
from app.llm.output_parser import LLMOutputError
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.user import User
from app.services.github_service import PullRequestMeta
from app.services.review_service import (
    RepositoryNotConnected,
    get_review_with_comments,
    resolve_repo_owner,
    run_review,
)

DIFF = """\
diff --git a/app/util.py b/app/util.py
--- a/app/util.py
+++ b/app/util.py
@@ -10,4 +10,5 @@ def helper():
 context
-old
+new
+extra
 context
"""

META = PullRequestMeta(
    number=7,
    title="Fix util",
    author="octocat",
    base_branch="main",
    head_branch="fix/util",
    head_sha="abc123",
    state="open",
)


def _payload(comments: list[dict]) -> str:
    return json.dumps({"summary": "One issue found.", "verdict": "comment", "comments": comments})


VALID_COMMENT = {
    "file": "app/util.py",
    "line_start": 11,
    "line_end": 12,
    "category": "logic_error",
    "severity": "warning",
    "comment": "Possible bug in the new branch.",
    "suggestion": "Guard against None.",
}


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        # run_review resolves the owning user from a connected Repository row.
        # Before AUTH-4 a phantom system user was invented on demand; now the
        # repository has to have been connected by somebody first.
        user = seed_user(session, github_id=1, username="octo")
        session.add(Repository(user_id=user.id, github_repo_id=9, full_name="octo/demo"))
        session.commit()
        yield session


def _run(db: Session, llm: FakeLLM, received_at: datetime | None = None) -> Review:
    return run_review(
        db,
        "octo",
        "demo",
        7,
        gh=FakeGitHub(pr_meta=META, pr_diff=DIFF),
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=llm,
        received_at=received_at,
    )


def _utc(value: datetime | None) -> datetime | None:
    """Re-attach UTC to a timestamp read back from SQLite.

    SQLAlchemy's SQLite dialect drops ``tzinfo`` on write, and
    ``expire_on_commit`` reloads the object at ``db.commit()`` — so a column
    declared ``DateTime(timezone=True)`` still comes back naive here, and
    comparing it to an aware ``datetime`` raises ``TypeError`` rather than
    failing an assertion. ``timezone=True`` is real only on Postgres.
    """
    return value if value is None or value.tzinfo else value.replace(tzinfo=timezone.utc)


def test_run_review_persists_review_and_comments(db: Session) -> None:
    review = _run(db, FakeLLM([_payload([VALID_COMMENT])]))

    assert review.status == "completed"
    assert review.model_used == "fake-model"
    assert review.tokens_used == 100
    assert review.summary == "One issue found."
    assert review.verdict == "comment"
    assert review.raw_diff == DIFF
    assert review.completed_at is not None

    fetched = get_review_with_comments(db, review.id)
    assert fetched is not None
    _, comments = fetched
    assert len(comments) == 1
    c = comments[0]
    assert (c.file_path, c.line_start, c.line_end) == ("app/util.py", 11, 12)
    assert c.category == "logic_error"
    assert c.severity == "warning"
    assert c.suggestion == "Guard against None."

    repo = db.scalar(select(Repository).where(Repository.full_name == "octo/demo"))
    assert repo is not None
    pr = db.scalar(select(PullRequest).where(PullRequest.repo_id == repo.id))
    assert pr is not None and pr.github_pr_number == 7 and pr.title == "Fix util"


def test_rereview_adds_review_row_but_not_pr_row(db: Session) -> None:
    first = _run(db, FakeLLM([_payload([VALID_COMMENT])]))
    second = _run(db, FakeLLM([_payload([])]))

    assert first.id != second.id
    assert db.scalar(select(Repository.full_name)) == "octo/demo"
    assert len(db.scalars(select(PullRequest)).all()) == 1
    assert len(db.scalars(select(Review)).all()) == 2


def test_llm_failure_marks_review_failed(db: Session) -> None:
    with pytest.raises(LLMOutputError):
        _run(db, FakeLLM(["nonsense"] * 3))

    review = db.scalars(select(Review)).one()
    assert review.status == "failed"
    assert review.completed_at is not None
    assert review.raw_diff == DIFF
    fetched = get_review_with_comments(db, review.id)
    assert fetched is not None and fetched[1] == []


def test_unindexed_repo_reviews_with_empty_context(db: Session) -> None:
    llm = FakeLLM([_payload([])])
    review = _run(db, llm)
    assert review.status == "completed"
    _, user_prompt = llm.prompts[0]
    assert "(no similar code found)" in user_prompt


def test_get_review_with_comments_missing_id(db: Session) -> None:
    assert get_review_with_comments(db, uuid.uuid4()) is None


def test_review_for_unconnected_repo_is_refused(db: Session) -> None:
    """No connected repository means there is nobody to own the review.

    Before AUTH-4 this silently invented a phantom system user, which let an
    unsolicited webhook create rows in the database.
    """
    with pytest.raises(RepositoryNotConnected):
        run_review(
            db,
            "stranger",
            "unknown",
            1,
            gh=FakeGitHub(pr_meta=META, pr_diff=DIFF),
            chroma_client=shared_chroma_client(),
            embedder=DeterministicEmbeddings(),
            llm=FakeLLM([_payload([])]),
        )

    assert db.scalars(select(Repository).where(Repository.full_name == "stranger/unknown")).all() == []


def test_resolve_repo_owner_picks_first_connector(db: Session) -> None:
    """full_name is not unique, so a webhook needs a deterministic owner."""
    second = seed_user(db, github_id=2, username="hubot")
    db.add(Repository(user_id=second.id, github_repo_id=9, full_name="octo/demo"))
    db.commit()

    first_owner = db.scalars(select(User).where(User.github_id == 1)).one()
    resolved = resolve_repo_owner(db, "octo/demo")
    assert resolved is not None and resolved.id == first_owner.id


# ── §8.1 instrumentation (METRIC-1) ──────────────────────────────────────────


def test_successful_review_records_duration(db: Session) -> None:
    review = _run(db, FakeLLM([_payload([VALID_COMMENT])]))

    assert review.duration_ms is not None
    # Milliseconds as an int, not seconds as a float — a float here invites
    # formatting bugs at display time.
    assert isinstance(review.duration_ms, int)
    assert review.duration_ms >= 0


def test_successful_review_records_tokens(db: Session) -> None:
    review = _run(db, FakeLLM([_payload([VALID_COMMENT])], tokens_per_call=250))
    assert review.tokens_used == 250


def test_successful_review_records_model(db: Session) -> None:
    review = _run(db, FakeLLM([_payload([])]))
    assert review.model_used == "fake-model"


def test_failed_review_still_records_duration(db: Session) -> None:
    """The one this issue is most likely to get wrong.

    The failure path rolls the session back before setting ``failed``, so a
    metric written inside the ``try`` — or in a ``finally`` that runs first —
    lands on state that is then discarded, and the column stays NULL on
    exactly the reviews worth investigating. A review that took forty seconds
    to fail is the most useful row in the table.
    """
    with pytest.raises(LLMOutputError):
        _run(db, FakeLLM(["nonsense"] * 3))

    review = db.scalars(select(Review)).one()
    assert review.status == "failed"
    assert review.duration_ms is not None
    assert review.duration_ms >= 0


def test_failed_review_duration_survives_a_refetch(db: Session) -> None:
    """Not just set on the in-memory object — actually committed."""
    with pytest.raises(LLMOutputError):
        _run(db, FakeLLM(["nonsense"] * 3))

    review_id = db.scalars(select(Review)).one().id
    db.expire_all()  # force a real read rather than trusting the identity map

    refetched = db.get(Review, review_id)
    assert refetched is not None
    assert refetched.duration_ms is not None


def test_metrics_are_null_before_completion(db: Session) -> None:
    """A row still in `processing` has nothing to report yet.

    Asserted through the same commit the pipeline makes, so this catches a
    default value creeping onto the column.
    """
    review = Review(pr_id=uuid.uuid4(), status="processing", raw_diff=DIFF)
    db.add(review)
    db.flush()

    assert review.duration_ms is None
    assert review.tokens_used is None
    assert review.model_used is None


def test_duration_covers_the_github_calls(db: Session) -> None:
    """Pins *where* the clock starts, which nothing else does.

    The two GitHub calls are the largest network payload in the pipeline
    before the LLM, and they run before the `processing` row is committed. A
    clock started after them omits latency the user genuinely waits through:
    measured with both calls costing 300ms, it recorded 16ms against a 328ms
    wall clock.

    Without this test the start point can drift back with every other test
    still green — which is how it was written the first time.
    """

    class SlowGitHub(FakeGitHub):
        def get_pull_request(self, owner: str, repo: str, number: int):
            time.sleep(0.08)
            return super().get_pull_request(owner, repo, number)

        def get_pull_request_diff(self, owner: str, repo: str, number: int) -> str:
            time.sleep(0.08)
            return super().get_pull_request_diff(owner, repo, number)

    review = run_review(
        db,
        "octo",
        "demo",
        7,
        gh=SlowGitHub(pr_meta=META, pr_diff=DIFF),
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=FakeLLM([_payload([])]),
    )

    assert review.duration_ms is not None
    # 160ms of deliberate GitHub latency; a generous floor clears platform
    # jitter while still failing a clock that starts after the fetch.
    assert review.duration_ms >= 120


def test_duration_is_measured_not_defaulted(db: Session) -> None:
    """The clock is real: a slower pipeline reports a larger number.

    A genuine delay rather than a faked ``time.monotonic`` — patching that
    hits the shared module, so every library call inside the pipeline gets
    the fake too and the scripted ticks run out.

    The assertion is *relative* rather than an absolute floor: Windows'
    timer granularity is coarse enough that ``sleep(0.05)`` can measure as
    46ms, which is a property of the platform clock and not of this code.
    Comparing two runs is the claim actually being made, and a hardcoded
    constant or a stray column default fails it either way.
    """

    class SlowLLM(FakeLLM):
        def complete(self, system: str, user: str):
            time.sleep(0.15)
            return super().complete(system, user)

    # Warm up and discard. The *first* pipeline run in a process pays one-time
    # costs the second never sees — creating the Chroma collection, building
    # the embedder. On a loaded CI runner that overhead measured 219ms while
    # the 150ms-slower run measured 154ms, failing this test on ordering
    # rather than on anything about the clock. Warming first puts both timed
    # runs on the same footing, which is the comparison being claimed.
    _run(db, FakeLLM([_payload([])]))

    fast = _run(db, FakeLLM([_payload([])]))
    slow = _run(db, SlowLLM([_payload([])]))

    assert fast.duration_ms is not None and slow.duration_ms is not None
    assert slow.duration_ms > fast.duration_ms
    # Generous floor: the sleep is 150ms, so this clears platform jitter
    # while still failing a zero or a constant.
    assert slow.duration_ms >= 100


# ── §8.1 end-to-end timing (METRIC-2) ────────────────────────────────────────


def test_records_queued_at_and_total_ms_when_provided(db: Session) -> None:
    received = datetime.now(timezone.utc)
    review = _run(db, FakeLLM([_payload([VALID_COMMENT])]), received_at=received)

    assert _utc(review.queued_at) == received
    assert review.total_ms is not None
    assert isinstance(review.total_ms, int)
    assert review.total_ms >= 0


def test_total_ms_is_none_for_manual_trigger(db: Session) -> None:
    """Manual triggers have no webhook receipt, so §8.1 has nothing to say.

    The point is what it must *not* do: fall back to ``duration_ms``. That
    would report a pipeline duration as an end-to-end one, which is exactly
    the confusion this column exists to remove — and it would be invisible,
    because the substituted number looks entirely plausible.

    ``duration_ms`` is asserted alongside so this cannot pass on a run that
    measured nothing at all.
    """
    review = _run(db, FakeLLM([_payload([])]))

    assert review.total_ms is None
    assert review.queued_at is None
    assert review.duration_ms is not None


def test_total_ms_is_at_least_duration_ms(db: Session) -> None:
    """End to end can never be shorter than the pipeline inside it.

    Written with a *known* second of pre-pipeline time rather than stamping
    ``now()`` immediately before the call. The naive form is true only up to
    cross-clock granularity — the two numbers come off different clocks in
    what is normally different processes — and would be the flakiest
    assertion in this file. A known offset makes it a real claim.
    """
    received = datetime.now(timezone.utc) - timedelta(seconds=1)
    review = _run(db, FakeLLM([_payload([])]), received_at=received)

    assert review.total_ms is not None and review.duration_ms is not None
    assert review.total_ms >= review.duration_ms + 900


def test_failed_review_still_records_total_ms(db: Session) -> None:
    """The rollback-path case METRIC-1 got wrong on its first attempt.

    ``total_ms`` is written in the same block as ``duration_ms``, after
    ``db.rollback()``, so it inherits that constraint rather than needing its
    own. This is where it will break again if anything moves.
    """
    received = datetime.now(timezone.utc)
    with pytest.raises(LLMOutputError):
        _run(db, FakeLLM(["nonsense"] * 3), received_at=received)

    review = db.scalars(select(Review)).one()
    assert review.status == "failed"
    assert review.total_ms is not None
    assert review.total_ms >= 0


def test_failed_review_total_ms_survives_a_refetch(db: Session) -> None:
    """Not just set on the in-memory object — actually committed."""
    with pytest.raises(LLMOutputError):
        _run(db, FakeLLM(["nonsense"] * 3), received_at=datetime.now(timezone.utc))

    review_id = db.scalars(select(Review)).one().id
    db.expire_all()  # force a real read rather than trusting the identity map

    refetched = db.get(Review, review_id)
    assert refetched is not None
    assert refetched.total_ms is not None
    assert refetched.queued_at is not None


def test_queued_at_is_recorded_even_when_the_review_fails(db: Session) -> None:
    """Set on the `processing` row, not in the tails.

    The rollback rewinds to that first commit, so the failure path gets it
    for free — and a review whose worker is killed outright still records
    when the webhook asked for it, which is the case where queue wait is
    most worth knowing.
    """
    received = datetime.now(timezone.utc)
    with pytest.raises(LLMOutputError):
        _run(db, FakeLLM(["nonsense"] * 3), received_at=received)

    review = db.scalars(select(Review)).one()
    assert _utc(review.queued_at) == received


def test_clock_skew_clamps_to_zero(db: Session) -> None:
    """Two hosts, two clocks — a receipt can land in the future.

    A negative end-to-end latency is a nonsense value that would poison the
    first average anyone computes over the column, so it clamps.
    """
    received = datetime.now(timezone.utc) + timedelta(seconds=30)
    review = _run(db, FakeLLM([_payload([])]), received_at=received)

    assert review.total_ms == 0


def test_naive_received_at_is_rejected_before_any_row_exists(db: Session) -> None:
    """A caller's naive datetime must cost nothing, not strand a review.

    Subtracting a naive ``received_at`` from the aware ``datetime.now`` in the
    tails raises — and both writes sit after the ``processing`` row is
    committed and before the tail's own commit. Unguarded, that leaves the
    review in ``processing`` **forever** and, on the failure path, replaces the
    original exception with a datetime error: the two things those writes exist
    to prevent, defeated at once.

    So the check lives at ``run_review``'s entry rather than in
    ``_wall_clock_ms``. Guarding the helper would only change which exception
    strands the row; refusing at entry means there is no row yet to strand,
    which is what the second assertion pins.

    Rejected rather than coerced to UTC: assuming is how a caller's offset
    becomes a 5.5-hour queue wait that parses and renders perfectly.
    """
    with pytest.raises(ValueError, match="timezone-aware"):
        _run(db, FakeLLM([_payload([])]), received_at=datetime.now())

    db.expire_all()
    assert db.scalars(select(Review)).all() == []


def test_naive_received_at_is_rejected_before_the_pipeline_runs(db: Session) -> None:
    """Entry validation, not late validation.

    The row assertion above proves nothing was stranded; this proves nothing
    was *spent* either — a bad argument should not cost two GitHub round trips
    and an LLM call before anyone notices.
    """

    class CountingGitHub(FakeGitHub):
        calls = 0

        def get_pull_request(self, owner, repo, number):
            type(self).calls += 1
            return super().get_pull_request(owner, repo, number)

    gh = CountingGitHub(pr_meta=META, pr_diff=DIFF)

    with pytest.raises(ValueError, match="timezone-aware"):
        run_review(
            db, "octo", "demo", 7,
            gh=gh,
            chroma_client=shared_chroma_client(),
            embedder=DeterministicEmbeddings(),
            llm=FakeLLM([_payload([])]),
            received_at=datetime.now(),
        )

    assert CountingGitHub.calls == 0


def test_total_ms_matches_the_stored_timestamps(db: Session) -> None:
    """The number is reconstructible from the row it sits on.

    ``completed_at`` and ``total_ms`` are computed from one instant rather
    than two ``now()`` calls, so `completed_at - queued_at` agrees with the
    stored figure instead of drifting from it by the width of the tail.
    """
    review = _run(db, FakeLLM([_payload([])]), received_at=datetime.now(timezone.utc))

    assert review.queued_at is not None and review.completed_at is not None
    span = review.completed_at - review.queued_at

    assert review.total_ms == int(span.total_seconds() * 1000)
