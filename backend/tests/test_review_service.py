import json
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
