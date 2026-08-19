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
from app.config import settings
from app.models.review_comment import ReviewComment
from app.services.diff_parser import parse_diff
from app.services.github_service import (
    GitHubWriteError,
    PostedReview,
    PullRequestMeta,
)
from app.services.review_service import (
    RepositoryNotConnected,
    get_review_with_comments,
    publish_review,
    resolve_repo_owner,
    run_review,
)



def review_actor(db: Session):
    """The connected repository's owner — who `run_review` acts as."""
    return db.scalars(select(User)).first()


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
    "suggestion": "return value if value is not None else fallback",
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
    assert c.suggestion == "return value if value is not None else fallback"

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


def test_a_provider_that_cannot_be_built_fails_visibly(db: Session) -> None:
    """The failure that looked like the review had simply vanished.

    Selecting `claude_code` on a worker without the CLI raised while the
    transport was being *constructed*. Built by the caller as an argument, that
    happened before any row existed: the task died, the queue emptied, and the
    reviews list stayed empty with the reason only in the worker log. The UI
    said "queued" and then showed nothing at all.
    """

    def cannot_build() -> FakeLLM:
        raise RuntimeError("'claude' is not on PATH")

    with pytest.raises(RuntimeError, match="not on PATH"):
        _run(db, cannot_build)

    # A row exists, says what happened, and says why.
    review = db.scalars(select(Review)).one()
    assert review.status == "failed"
    assert review.completed_at is not None
    assert "not on PATH" in (review.summary or "")


def test_a_working_provider_may_still_be_passed_directly(db: Session) -> None:
    """The factory is accepted, not required — every existing caller passes an
    instance and must keep working."""
    review = _run(db, FakeLLM([_payload([])]))
    assert review.status == "completed"


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


# ── Posting to GitHub (GH-2) ──────────────────────────────────────────────────


class PostingGitHub(FakeGitHub):
    """FakeGitHub that records review posts instead of making them.

    Every test in this section runs with no network and no token — the
    property protected through every GitHub issue so far.
    """

    def __init__(self, *args, raises: Exception | None = None, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.posted: list[dict] = []
        self.raises = raises

    def create_pull_request_review(
        self, owner, repo, number, *, body, event, comments=None
    ) -> PostedReview:
        if self.raises is not None:
            raise self.raises
        self.posted.append(
            {"owner": owner, "repo": repo, "number": number,
             "body": body, "event": event, "comments": comments or []}
        )
        return PostedReview(
            id=900 + len(self.posted),
            html_url=f"https://github.com/{owner}/{repo}/pull/{number}#r{900 + len(self.posted)}",
            state="COMMENTED",
        )


def _run_with(db: Session, llm: FakeLLM, gh: PostingGitHub) -> Review:
    return run_review(
        db, "octo", "demo", 7,
        gh=gh,
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=llm,
    )


@pytest.fixture()
def posting_enabled(monkeypatch):
    monkeypatch.setattr(settings, "post_reviews_to_github", True)
    monkeypatch.setattr(settings, "github_review_event_mode", "comment_only")


def test_posting_disabled_by_default_makes_no_calls(db: Session) -> None:
    """The default, and the reason the test suite is never one env var away
    from writing to a real pull request."""
    gh = PostingGitHub(pr_meta=META, pr_diff=DIFF)
    review = _run_with(db, FakeLLM([_payload([VALID_COMMENT])]), gh)

    assert gh.posted == []
    assert review.github_review_id is None
    assert review.posted_at is None
    assert review.post_error is None


def test_enabled_posts_after_the_review_is_committed(db: Session, posting_enabled) -> None:
    """The review must be durable in Liffy before Liffy tries to publish it —
    a GitHub outage should cost a publish, not a review."""
    committed: list[str] = []

    class ChecksDb(PostingGitHub):
        def create_pull_request_review(self, *args, **kwargs):
            # The row is already visible to a *separate* session, which is only
            # true if the commit happened first.
            with Session(db.get_bind()) as other:
                row = other.scalars(select(Review)).one()
                committed.append(row.status)
            return super().create_pull_request_review(*args, **kwargs)

    gh = ChecksDb(pr_meta=META, pr_diff=DIFF)
    review = _run_with(db, FakeLLM([_payload([VALID_COMMENT])]), gh)

    assert committed == ["completed"]
    assert review.github_review_id is not None


def test_records_github_review_id_and_url(db: Session, posting_enabled) -> None:
    gh = PostingGitHub(pr_meta=META, pr_diff=DIFF)
    review = _run_with(db, FakeLLM([_payload([VALID_COMMENT])]), gh)

    assert review.github_review_id == 901
    assert "pull/7" in review.github_review_url
    assert review.posted_at is not None
    assert review.post_error is None


def test_posting_failure_does_not_fail_the_review(db: Session, posting_enabled) -> None:
    """The most important test here.

    The review is complete — in the database, visible in the UI. Letting a
    GitHub 500 flip it to `failed` would be strictly worse than not posting.
    """
    gh = PostingGitHub(
        pr_meta=META, pr_diff=DIFF,
        raises=GitHubWriteError("rejected", status_code=422, body="Line could not be resolved"),
    )
    review = _run_with(db, FakeLLM([_payload([VALID_COMMENT])]), gh)

    assert review.status == "completed"
    assert review.github_review_id is None
    assert review.post_error is not None
    assert "Line could not be resolved" in review.post_error
    # And the comments survived the rollback in the error path.
    assert db.scalars(select(ReviewComment)).all()


def test_already_posted_review_is_not_posted_again(db: Session, posting_enabled) -> None:
    """The duplicate-comment guard.

    `synchronize` webhooks fire on every push; without this a PR pushed to five
    times accumulates five duplicate threads.
    """
    gh = PostingGitHub(pr_meta=META, pr_diff=DIFF)
    review = _run_with(db, FakeLLM([_payload([VALID_COMMENT])]), gh)
    assert len(gh.posted) == 1

    publish_review(db, review, "octo", "demo", META, parse_diff(DIFF), gh=gh, actor=review_actor(db))
    assert len(gh.posted) == 1


def test_a_rereview_posts_a_fresh_review_naming_the_one_it_supersedes(
    db: Session, posting_enabled
) -> None:
    """GitHub has no update-a-review API, and a COMMENTED review cannot be
    dismissed — so the new review says which one it replaces."""
    gh = PostingGitHub(pr_meta=META, pr_diff=DIFF)
    _run_with(db, FakeLLM([_payload([VALID_COMMENT])]), gh)
    _run_with(db, FakeLLM([_payload([VALID_COMMENT])]), gh)

    assert len(gh.posted) == 2
    assert "supersedes" in gh.posted[1]["body"].lower()
    assert "#r901" in gh.posted[1]["body"]


def test_own_pr_verdict_is_downgraded_and_the_body_says_so(
    db: Session, monkeypatch
) -> None:
    """`META.author` is "octocat"; the connected repo's owner is "octo"."""
    monkeypatch.setattr(settings, "post_reviews_to_github", True)
    monkeypatch.setattr(settings, "github_review_event_mode", "native")

    own_meta = PullRequestMeta(**{**META.__dict__, "author": "octo"})
    gh = PostingGitHub(pr_meta=own_meta, pr_diff=DIFF)
    payload = json.dumps(
        {"summary": "s", "verdict": "request_changes", "comments": [VALID_COMMENT]}
    )
    _run_with(db, FakeLLM([payload]), gh)

    assert gh.posted[0]["event"] == "COMMENT"
    assert "your own pull request" in gh.posted[0]["body"]


def test_native_mode_sends_request_changes_on_someone_elses_pr(
    db: Session, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "post_reviews_to_github", True)
    monkeypatch.setattr(settings, "github_review_event_mode", "native")

    gh = PostingGitHub(pr_meta=META, pr_diff=DIFF)  # author "octocat" != owner "octo"
    payload = json.dumps(
        {"summary": "s", "verdict": "request_changes", "comments": [VALID_COMMENT]}
    )
    _run_with(db, FakeLLM([payload]), gh)

    assert gh.posted[0]["event"] == "REQUEST_CHANGES"


DELETION_DIFF = DIFF + """\
@@ -30,3 +32,0 @@ def gone():
-a
-b
-c
"""


def test_unanchorable_comments_appear_in_the_body(db: Session, posting_enabled) -> None:
    """The narrow case BASE-7's anchoring cannot catch.

    `_anchor_comments` already drops comments outside every hunk, so most
    unanchorable comments never reach the database. It tests against
    `hunk.new_line_range`, which for a **pure-deletion hunk** is
    `(new_start, new_start)` — a single line that has no actual new-file
    counterpart. So a comment there survives anchoring and GitHub still cannot
    place it, because `side: RIGHT` has nothing to point at.

    Verified: for the hunk `@@ -30,3 +32,0 @@`, anchoring accepts line 32 and
    `is_line_commentable` rejects it.

    Dropping it silently would lose a real finding, so it goes in the body.
    """
    orphan = {**VALID_COMMENT, "line_start": 32, "line_end": 32,
              "comment": "Removed helper is still referenced."}
    gh = PostingGitHub(pr_meta=META, pr_diff=DELETION_DIFF)
    _run_with(db, FakeLLM([_payload([orphan])]), gh)

    assert gh.posted[0]["comments"] == []
    assert "Removed helper is still referenced." in gh.posted[0]["body"]
    assert "could not be anchored" in gh.posted[0]["body"]


def test_no_anchorable_comments_still_posts_the_summary(db: Session, posting_enabled) -> None:
    gh = PostingGitHub(pr_meta=META, pr_diff=DIFF)
    _run_with(db, FakeLLM([_payload([])]), gh)

    assert len(gh.posted) == 1
    assert "One issue found." in gh.posted[0]["body"]


def test_failed_review_is_not_posted(db: Session, posting_enabled) -> None:
    """A review that never completed has nothing to publish."""
    gh = PostingGitHub(pr_meta=META, pr_diff=DIFF)
    with pytest.raises(Exception):
        _run_with(db, FakeLLM(["not json"] * 5), gh)

    assert gh.posted == []


def test_posting_does_not_extend_the_duration_clock(db: Session, posting_enabled) -> None:
    """`duration_ms` measures generating a review, not publishing it.

    Folding the GitHub round trip in would inflate §8.1's number with work the
    target is not about.
    """
    class SlowPost(PostingGitHub):
        def create_pull_request_review(self, *args, **kwargs):
            time.sleep(0.15)
            return super().create_pull_request_review(*args, **kwargs)

    gh = SlowPost(pr_meta=META, pr_diff=DIFF)
    review = _run_with(db, FakeLLM([_payload([VALID_COMMENT])]), gh)

    assert review.duration_ms < 150


# ── The failure handler has to be total ───────────────────────────────────────


class _Exploding:
    """A provider whose `complete` raises whatever it was handed."""

    model_name = "boom"

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def complete(self, system: str, user: str):
        raise self._exc


def test_a_non_string_detail_does_not_take_the_record_down_with_it(
    db: Session,
) -> None:
    """`getattr(exc, "detail", ...)` duck-typed on a very common attribute name.

    `fastapi.HTTPException.detail` carries one that can be a dict or a list,
    and assigning that to a Text column raises a *second* exception inside the
    failure handler — losing the record of the first. Whatever went wrong, a
    row describing it has to survive.
    """

    class Impostor(RuntimeError):
        detail = {"not": "a string"}
        kind = ["not", "a", "string"]

    with pytest.raises(Impostor):
        _run(db, _Exploding(Impostor("something else entirely")))

    review = db.scalars(select(Review)).one()
    assert review.status == "failed"
    # Neither impostor attribute reached the columns.
    assert review.failure_detail is None
    assert review.failure_kind == "unknown"


def test_a_subscription_error_records_its_detail_and_kind(db: Session) -> None:
    from app.llm.chain import SubscriptionLimitError

    exc = SubscriptionLimitError(
        "out of allowance", detail='{"is_error": true}', kind="limit"
    )
    with pytest.raises(SubscriptionLimitError):
        _run(db, _Exploding(exc))

    review = db.scalars(select(Review)).one()
    assert review.failure_kind == "limit"
    assert review.failure_detail == '{"is_error": true}'
    # The sentence stays a sentence.
    assert "{" not in review.summary


def test_a_connection_error_is_recorded_as_infrastructure(db: Session) -> None:
    """`infra` was documented in three places and produced by none.

    The recorded `[Errno 111] Connection refused` is an OSError, so without a
    branch for it `FIXES.infra` in the UI was unreachable code.
    """
    with pytest.raises(OSError):
        _run(db, _Exploding(ConnectionRefusedError(111, "Connection refused")))

    review = db.scalars(select(Review)).one()
    assert review.failure_kind == "infra"
    assert review.failure_detail is None


# ── Incremental re-review ─────────────────────────────────────────────────────
#
# Every re-review used to re-fetch `base...head` and hand all of it to the
# model, so pushing a one-line fix to a large pull request cost the same as
# reviewing it from scratch — measured at ~100k tokens a pass on this
# repository's own PRs.

SECOND_DIFF = """diff --git a/app/util.py b/app/util.py
index 1111111..2222222 100644
--- a/app/util.py
+++ b/app/util.py
@@ -30,2 +30,3 @@ def other():
 keep
+added later
 tail
"""


def _run_gh(
    db: Session, llm: FakeLLM, gh: FakeGitHub, *, automatic: bool = True
) -> Review:
    """`received_at` is what the webhook sets and a button does not, so it is
    also what decides whether a review may be narrowed."""
    return run_review(
        db, "octo", "demo", 7,
        gh=gh,
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=llm,
        received_at=datetime(2026, 8, 1, tzinfo=timezone.utc) if automatic else None,
    )


def _meta_at(sha: str) -> PullRequestMeta:
    return PullRequestMeta(
        number=7, title="Fix util", author="octocat", base_branch="main",
        head_branch="fix/util", head_sha=sha, state="open",
    )


def test_the_first_review_records_what_it_looked_at(db: Session) -> None:
    review = _run(db, FakeLLM([_payload([])]))
    assert review.head_sha == "abc123"


def test_the_first_review_is_not_scoped(db: Session) -> None:
    """Nothing to diff from, so it sees the whole pull request."""
    gh = FakeGitHub(pr_meta=META, pr_diff=DIFF)
    _run_gh(db, FakeLLM([_payload([])]), gh)
    assert gh.compare_calls == []


def test_a_re_review_at_a_new_commit_only_sees_what_landed(db: Session) -> None:
    _run(db, FakeLLM([_payload([])]))

    gh = FakeGitHub(pr_meta=_meta_at("def456"), pr_diff=DIFF)
    gh.compare_diff = SECOND_DIFF
    _run_gh(db, FakeLLM([_payload([])]), gh)

    assert gh.compare_calls == [("abc123", "def456")]


def test_a_re_review_at_the_same_commit_still_reads_everything(db: Session) -> None:
    """A re-review at the same commit is a deliberate "look again".

    Narrowing it to an empty diff would answer a request to re-read with
    silence, which is worse than the cost it saves.
    """
    _run(db, FakeLLM([_payload([])]))

    gh = FakeGitHub(pr_meta=META, pr_diff=DIFF)
    _run_gh(db, FakeLLM([_payload([])]), gh)

    assert gh.compare_calls == []


def test_a_failed_predecessor_is_not_diffed_from(db: Session) -> None:
    """A review that failed said nothing about the code.

    Diffing from it would skip every commit between it and the one before —
    the difference between a cheaper review and one with a hole in it.
    """
    with pytest.raises(LLMOutputError):
        _run(db, FakeLLM(["nonsense"] * 3))

    gh = FakeGitHub(pr_meta=_meta_at("def456"), pr_diff=DIFF)
    gh.compare_diff = SECOND_DIFF
    _run_gh(db, FakeLLM([_payload([])]), gh)

    assert gh.compare_calls == []


def test_an_unreachable_commit_falls_back_to_the_whole_diff(db: Session) -> None:
    """A force-push orphans the old commit and GitHub answers 404.

    This is an optimisation; an expensive review is a far better outcome than
    no review, so nothing here may raise.
    """
    _run(db, FakeLLM([_payload([])]))

    gh = FakeGitHub(pr_meta=_meta_at("def456"), pr_diff=DIFF)
    gh.compare_diff = None  # makes compare raise
    review = _run_gh(db, FakeLLM([_payload([])]), gh)

    assert gh.compare_calls == [("abc123", "def456")]
    assert review.status == "completed"


def test_an_empty_comparison_falls_back_rather_than_reviewing_nothing(
    db: Session,
) -> None:
    """A comparison that parses to no files is a merge commit or a base move."""
    _run(db, FakeLLM([_payload([])]))

    gh = FakeGitHub(pr_meta=_meta_at("def456"), pr_diff=DIFF)
    gh.compare_diff = ""
    review = _run_gh(db, FakeLLM([_payload([])]), gh)

    assert review.status == "completed"


def test_raw_diff_is_always_the_whole_pull_request(db: Session) -> None:
    """Comments are anchored and posted against this, never the increment.

    GitHub only accepts an inline comment on a line in the pull request's own
    diff, and a line touched in one commit and reverted in the next is in the
    increment but not in `base...head`. Validating against the narrower diff
    risks a 422 that rejects the whole review.
    """
    _run(db, FakeLLM([_payload([])]))

    gh = FakeGitHub(pr_meta=_meta_at("def456"), pr_diff=DIFF)
    gh.compare_diff = SECOND_DIFF
    review = _run_gh(db, FakeLLM([_payload([])]), gh)

    assert review.raw_diff == DIFF
    assert "added later" not in review.raw_diff


def test_a_review_a_person_asked_for_reads_everything(db: Session) -> None:
    """Narrowing means each hunk is looked at once, where before every pass
    re-read everything and a later pass could catch what an earlier one missed.

    That redundancy was accidental but real — on #274, passes two and three
    each found defects present and unremarked during pass one. So a push gets
    the cheap check and a person clicking Re-review gets the whole pull
    request, and a miss is never permanent.
    """
    _run(db, FakeLLM([_payload([])]))

    gh = FakeGitHub(pr_meta=_meta_at("def456"), pr_diff=DIFF)
    gh.compare_diff = SECOND_DIFF
    _run_gh(db, FakeLLM([_payload([])]), gh, automatic=False)

    assert gh.compare_calls == []


def test_a_push_still_gets_the_cheap_check(db: Session) -> None:
    _run(db, FakeLLM([_payload([])]))

    gh = FakeGitHub(pr_meta=_meta_at("def456"), pr_diff=DIFF)
    gh.compare_diff = SECOND_DIFF
    _run_gh(db, FakeLLM([_payload([])]), gh, automatic=True)

    assert gh.compare_calls == [("abc123", "def456")]


# ── The commit picker ─────────────────────────────────────────────────────────

SHA_ONE = "aaaaaaa1111111111111111111111111111111a1"
SHA_GONE = "ffffffff9999999999999999999999999999999f"
#
# Selecting commits picks *files*, and those files are reviewed as they stand
# at the pull request's head — not as the selected commits left them. That is
# what makes skipping a commit in the middle safe: there are no stale line
# numbers to re-anchor, because nothing is read at an old revision.


def _picker_gh(commit_files: dict) -> FakeGitHub:
    gh = FakeGitHub(pr_meta=META, pr_diff=DIFF)
    gh.commit_files = commit_files
    return gh


def test_selected_commits_narrow_the_review_to_the_files_they_touched(
    db: Session,
) -> None:
    gh = _picker_gh({SHA_ONE: ["app/util.py"]})

    run_review(
        db, "octo", "demo", 7, gh=gh,
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=FakeLLM([_payload([])]),
        commit_shas=[SHA_ONE],
    )

    assert gh.files_in_commits_calls == [[SHA_ONE]]


def test_a_selection_touching_nothing_in_the_diff_reviews_everything(
    db: Session,
) -> None:
    """Reverted, or outside the pull request entirely.

    Reviewing everything is wrong here, but reviewing nothing is worse — a
    request to look at something answered with silence.
    """
    gh = _picker_gh({SHA_ONE: ["docs/unrelated.md"]})

    review = run_review(
        db, "octo", "demo", 7, gh=gh,
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=FakeLLM([_payload([])]),
        commit_shas=[SHA_ONE],
    )

    assert review.status == "completed"


def test_an_unresolvable_commit_falls_back_rather_than_failing(db: Session) -> None:
    """A force-push orphans the sha and GitHub answers 404.

    Every scoping failure widens; none of them may raise. An expensive review
    is a far better outcome than none.
    """
    gh = _picker_gh({})  # any sha raises

    review = run_review(
        db, "octo", "demo", 7, gh=gh,
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=FakeLLM([_payload([])]),
        commit_shas=[SHA_GONE],
    )

    assert review.status == "completed"


def test_the_picker_beats_incremental_scoping(db: Session) -> None:
    """A named selection is a stronger signal than "what changed since".

    Both narrow, and asking for specific commits should not then be widened or
    re-narrowed by the automatic rule — so the compare endpoint is never
    consulted when a selection is given.
    """
    _run(db, FakeLLM([_payload([])]))

    gh = _picker_gh({SHA_ONE: ["app/util.py"]})
    gh.pr_meta = _meta_at("def456")
    gh.compare_diff = SECOND_DIFF

    run_review(
        db, "octo", "demo", 7, gh=gh,
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=FakeLLM([_payload([])]),
        received_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
        commit_shas=[SHA_ONE],
    )

    assert gh.compare_calls == []
    assert gh.files_in_commits_calls == [[SHA_ONE]]


def test_raw_diff_stays_whole_under_a_selection(db: Session) -> None:
    """Comments are still anchored and posted against the full pull request."""
    gh = _picker_gh({SHA_ONE: ["app/util.py"]})

    review = run_review(
        db, "octo", "demo", 7, gh=gh,
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=FakeLLM([_payload([])]),
        commit_shas=[SHA_ONE],
    )

    assert review.raw_diff == DIFF


TWO_FILE_DIFF = """\
diff --git a/app/util.py b/app/util.py
--- a/app/util.py
+++ b/app/util.py
@@ -10,4 +10,5 @@ def helper():
 context
-old
+new
+extra
 context
diff --git a/docs/notes.md b/docs/notes.md
--- a/docs/notes.md
+++ b/docs/notes.md
@@ -1,2 +1,3 @@ notes
 keep
+a line nobody selected
 tail
"""


def test_a_narrowed_review_records_what_it_actually_read(db: Session) -> None:
    """`raw_diff` is the whole pull request, so the header would otherwise
    report its file count for a review that read a fraction of it.

    Somebody who picked three commits and saw "17 files" would reasonably
    conclude the picker had not worked. It had; the page was describing the
    wrong thing.
    """
    gh = _picker_gh({SHA_ONE: ["app/util.py"]})
    gh.pr_diff = TWO_FILE_DIFF  # the selection has something to exclude

    review = run_review(
        db, "octo", "demo", 7, gh=gh,
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=FakeLLM([_payload([])]),
        commit_shas=[SHA_ONE],
    )

    scope = (review.summary_detail or {}).get("scope")
    assert scope is not None
    assert scope["files_reviewed"] < scope["files_in_diff"]


def test_an_unnarrowed_review_records_no_scope(db: Session) -> None:
    """Nothing to explain when everything was read — and a scope line on every
    review would be noise on the common case."""
    review = _run(db, FakeLLM([_payload([])]))

    assert "scope" not in (review.summary_detail or {})


def test_a_narrowed_review_records_which_commits_it_covered(db: Session) -> None:
    """So the picker can tell a skipped commit from a reviewed one.

    Without this the boundary is `head_sha`, which a narrowed review also
    reaches — it read the head, just not all of it — and every commit before
    it reads as reviewed.
    """
    gh = _picker_gh({SHA_ONE: ["app/util.py"]})
    gh.pr_diff = TWO_FILE_DIFF

    review = run_review(
        db, "octo", "demo", 7, gh=gh,
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=FakeLLM([_payload([])]),
        commit_shas=[SHA_ONE],
    )

    assert (review.summary_detail or {})["scope"]["commits"] == [SHA_ONE]


def test_an_automatic_incremental_review_records_no_commit_list(db: Session) -> None:
    """It narrowed by *range*, not by selection — every commit in that range
    was read, so there is nothing to exclude from the boundary."""
    _run(db, FakeLLM([_payload([])]))

    gh = FakeGitHub(pr_meta=_meta_at("def456"), pr_diff=DIFF)
    gh.compare_diff = SECOND_DIFF
    review = _run_gh(db, FakeLLM([_payload([])]), gh, automatic=True)

    assert "commits" not in ((review.summary_detail or {}).get("scope") or {})
