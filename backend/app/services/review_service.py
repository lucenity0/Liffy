"""End-to-end review orchestration (report §3.1 steps 10-12).

``run_review`` is the single entry point the Celery worker (BASE-9) calls:
fetch PR (BASE-3) -> parse diff (BASE-4) -> retrieve context (BASE-6) ->
generate (BASE-7) -> persist review + comments. All I/O dependencies are
injected, so the pipeline is testable offline.
"""

import time
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.llm.chain import ReviewLLM, generate_review
from app.llm.embeddings import EmbeddingProvider
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.review_comment import ReviewComment
from app.models.user import User
from app.services.diff_parser import FileStatus, parse_diff
from app.services.github_service import GitHubClient, PullRequestMeta
from app.services.rag_service import RetrievedChunk, retrieve_for_file_diff

# Total retrieved-context budget per review, across all changed files.
MAX_CONTEXT_CHUNKS = 10


def _wall_clock_ms(start: datetime | None, end: datetime) -> int | None:
    """Milliseconds between two wall-clock instants, or None if unmeasured.

    Wall clock unavoidably, unlike ``duration_ms``: the start is stamped in the
    API process and the end here in the worker, and ``time.monotonic()`` is
    only comparable within one process. That means METRIC-1's warning about
    NTP corrections and DST jumps genuinely applies to this number, and two
    hosts can also simply disagree with each other.

    Clamped at 0 rather than stored negative. A negative end-to-end latency is
    a nonsense value that would poison the first average anyone computes; a 0
    reads honestly as "receipt and completion were indistinguishable, or the
    clocks disagree".
    """
    if start is None:
        return None
    return max(0, int((end - start).total_seconds() * 1000))


class RepositoryNotConnected(RuntimeError):
    """A review was requested for a repository nobody has connected.

    Raised instead of inventing an owner: before AUTH-4 a phantom system user
    absorbed these, which meant an unsolicited webhook could create rows in
    the database.
    """


def resolve_repo_owner(db: Session, full_name: str) -> User | None:
    """Which user a webhook-driven review belongs to.

    Nothing stops two users connecting the same repository — ``full_name`` has
    no unique constraint — and a webhook carries no user context to choose
    between them. First connector wins: it is deterministic, and it keeps the
    review attached to whoever set the integration up.

    Returns the ``User`` rather than an id so the workers can read the owner's
    GitHub token from the same lookup, keeping this rule in one place.
    """
    return db.scalar(
        select(User)
        .join(Repository, Repository.user_id == User.id)
        .where(Repository.full_name == full_name)
        .order_by(Repository.created_at)
        .limit(1)
    )


def ensure_repo_and_pr(
    db: Session, owner: str, repo_name: str, pr_meta: PullRequestMeta, user_id: uuid.UUID
) -> tuple[Repository, PullRequest]:
    full_name = f"{owner}/{repo_name}"
    repo = db.scalar(
        select(Repository).where(
            Repository.full_name == full_name, Repository.user_id == user_id
        )
    )
    if repo is None:
        repo = Repository(user_id=user_id, github_repo_id=0, full_name=full_name)
        db.add(repo)
        db.flush()

    pr = db.scalar(
        select(PullRequest).where(
            PullRequest.repo_id == repo.id,
            PullRequest.github_pr_number == pr_meta.number,
        )
    )
    if pr is None:
        pr = PullRequest(repo_id=repo.id, github_pr_number=pr_meta.number, title="", author="")
        db.add(pr)
    # (Re-)sync mutable PR fields from GitHub on every trigger.
    pr.title = pr_meta.title
    pr.author = pr_meta.author
    pr.base_branch = pr_meta.base_branch
    pr.head_branch = pr_meta.head_branch
    pr.status = pr_meta.state
    db.flush()
    return repo, pr


def _gather_context(
    chroma_client, repo_id: uuid.UUID, file_diffs, embedder: EmbeddingProvider
) -> list[RetrievedChunk]:
    """Merge per-file retrievals into one review-level context list."""
    best: dict[tuple[str, int], RetrievedChunk] = {}
    for fd in file_diffs:
        if fd.is_binary or fd.status == FileStatus.deleted:
            continue
        for hit in retrieve_for_file_diff(chroma_client, repo_id, fd, embedder=embedder):
            key = (hit.file_path, hit.start_line)
            if key not in best or hit.distance < best[key].distance:
                best[key] = hit
    return sorted(best.values(), key=lambda c: c.distance)[:MAX_CONTEXT_CHUNKS]


def run_review(
    db: Session,
    owner: str,
    repo_name: str,
    pr_number: int,
    *,
    gh: GitHubClient,
    chroma_client,
    embedder: EmbeddingProvider,
    llm: ReviewLLM,
    received_at: datetime | None = None,
) -> Review:
    # Report §8.1's clock. First statement in the function on purpose: the two
    # GitHub calls below are the largest network payload in the pipeline
    # before the LLM, and starting the clock after them makes real latency a
    # user waits through invisible. Measured with both calls costing 300ms,
    # starting it lower down recorded 16ms against a 328ms wall clock.
    #
    # `monotonic`, not `datetime.now()`: a wall clock can jump backwards on an
    # NTP correction or a DST change, and a negative duration in the metrics
    # table is worse than no duration at all.
    started = time.monotonic()

    def elapsed_ms() -> int:
        return int((time.monotonic() - started) * 1000)

    # Resolve the owner before spending a GitHub call: a review for a
    # repository nobody connected has no one to belong to.
    owner_user = resolve_repo_owner(db, f"{owner}/{repo_name}")
    if owner_user is None:
        raise RepositoryNotConnected(f"{owner}/{repo_name}")

    meta = gh.get_pull_request(owner, repo_name, pr_number)
    raw_diff = gh.get_pull_request_diff(owner, repo_name, pr_number)
    repo, pr = ensure_repo_and_pr(db, owner, repo_name, meta, owner_user.id)

    # Commit the processing row first: a crash mid-pipeline leaves an
    # inspectable record, and the API can report status while we work.
    #
    # `queued_at` goes on here rather than in the tails below so it survives
    # that crash: a review whose worker is killed still records when the
    # webhook asked for it, which is the case where queue wait is most worth
    # knowing. The rollback on the failure path rewinds to this commit, so the
    # failure path inherits it for free.
    review = Review(pr_id=pr.id, status="processing", raw_diff=raw_diff, queued_at=received_at)
    db.add(review)
    db.commit()

    try:
        file_diffs = parse_diff(raw_diff)
        context = _gather_context(chroma_client, repo.id, file_diffs, embedder)
        result = generate_review(llm, meta.title, file_diffs, context)

        for comment in result.output.comments:
            db.add(
                ReviewComment(
                    review_id=review.id,
                    file_path=comment.file,
                    line_start=comment.line_start,
                    line_end=comment.line_end,
                    category=comment.category.value,
                    severity=comment.severity.value,
                    comment_text=comment.comment,
                    suggestion=comment.suggestion,
                )
            )
        review.summary = result.output.summary
        review.verdict = result.output.verdict.value
        review.status = "completed"
        review.model_used = result.model_used
        review.tokens_used = result.tokens_used
        review.duration_ms = elapsed_ms()
        # One instant for both, so `total_ms` stays reconstructible from the
        # row as `completed_at - queued_at`.
        completed = datetime.now(timezone.utc)
        review.completed_at = completed
        review.total_ms = _wall_clock_ms(received_at, completed)
        db.commit()
        return review
    except Exception:
        db.rollback()  # discard any partial comment rows

        # Every write below has to come *after* the rollback. Setting
        # duration_ms before it — inside the try, or in a finally that runs
        # first — would put the value on a session state that is then thrown
        # away, and the column would silently stay NULL on exactly the reviews
        # worth investigating.
        #
        # A review that took forty seconds to fail is the most useful data
        # point in the table, so the failure path records the clock too.
        review.status = "failed"
        review.duration_ms = elapsed_ms()
        completed = datetime.now(timezone.utc)
        review.completed_at = completed
        review.total_ms = _wall_clock_ms(received_at, completed)
        db.commit()
        raise


def get_review_with_comments(
    db: Session, review_id: uuid.UUID
) -> tuple[Review, list[ReviewComment]] | None:
    review = db.get(Review, review_id)
    if review is None:
        return None
    comments = db.scalars(
        select(ReviewComment)
        .where(ReviewComment.review_id == review.id)
        .order_by(ReviewComment.file_path, ReviewComment.line_start)
    ).all()
    return review, list(comments)
