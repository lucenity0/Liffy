import json
import time
import uuid

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


def _run(db: Session, llm: FakeLLM) -> Review:
    return run_review(
        db,
        "octo",
        "demo",
        7,
        gh=FakeGitHub(pr_meta=META, pr_diff=DIFF),
        chroma_client=shared_chroma_client(),
        embedder=DeterministicEmbeddings(),
        llm=llm,
    )


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

    fast = _run(db, FakeLLM([_payload([])]))
    slow = _run(db, SlowLLM([_payload([])]))

    assert fast.duration_ms is not None and slow.duration_ms is not None
    assert slow.duration_ms > fast.duration_ms
    # Generous floor: the sleep is 150ms, so this clears platform jitter
    # while still failing a zero or a constant.
    assert slow.duration_ms >= 100
