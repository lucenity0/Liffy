"""End-to-end review orchestration (report §3.1 steps 10-12).

``run_review`` is the single entry point the Celery worker (BASE-9) calls:
fetch PR (BASE-3) -> parse diff (BASE-4) -> retrieve context (BASE-6) ->
generate (BASE-7) -> persist review + comments. All I/O dependencies are
injected, so the pipeline is testable offline.
"""

import logging
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
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
from app.services.review_publisher import (
    build_review_body,
    partition_comments,
    resolve_event,
    truncate_post_error,
)

logger = logging.getLogger(__name__)

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

    **Precondition: ``start`` is timezone-aware or None.** Subtracting a naive
    one from an aware ``end`` raises, and both call sites are in ``run_review``
    tails *after* the ``processing`` row is committed and *before* the tail's
    own commit — so a raise here strands the review in ``processing`` forever
    and masks whatever the original failure was. ``run_review`` therefore
    rejects a naive ``received_at`` at entry, before any row exists; do not
    weaken that check and rely on a guard here instead, because by the time
    this runs there is already something to strand.
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
    # Validated here, before the clock and before any row is written.
    #
    # A naive `received_at` cannot be subtracted from the aware `datetime.now`
    # in the tails, and that raise would land after the `processing` row is
    # committed but before the tail commits — stranding the review in
    # `processing` forever and masking the original exception on the failure
    # path. Checking at entry means the caller's mistake costs nothing: no
    # clock, no GitHub calls, no row, nothing to strand.
    #
    # Rejected rather than coerced. Assuming UTC is how the caller's offset
    # becomes a 5.5-hour "queue wait" that parses and renders perfectly, which
    # is the failure `_parse_received_at` refuses upstream for the same reason.
    if received_at is not None and received_at.tzinfo is None:
        raise ValueError(
            "received_at must be timezone-aware; a naive datetime would record "
            "the caller's UTC offset as queue wait"
        )

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

    # Posting sits **after** the commit above and **outside** its `try`, both
    # on purpose.
    #
    # After, because the review must be durable in Liffy before Liffy tries to
    # publish it: a GitHub outage should cost a publish, not a review.
    #
    # Outside, because an exception here landing in that `except` branch would
    # flip a completed review to `failed` — the exact opposite of what §1
    # wants, and a strictly worse outcome than not posting. `publish_review`
    # owns its own error handling and never raises.
    #
    # `duration_ms` was recorded before this runs and deliberately does not
    # extend over it: the GitHub round trip is not part of generating a review,
    # and folding it in would inflate §8.1's number with work the target is not
    # about.
    publish_review(db, review, owner, repo_name, meta, file_diffs, gh=gh, actor=owner_user)
    return review


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


def _previous_posted_review_url(db: Session, review: Review) -> str | None:
    """The most recent Liffy review already on this PR, if any.

    Read from Liffy's own rows rather than by listing GitHub's reviews: we know
    exactly which ones are ours, and listing would need a second API call to
    rediscover something already recorded.
    """
    return db.scalar(
        select(Review.github_review_url)
        .where(
            Review.pr_id == review.pr_id,
            Review.id != review.id,
            Review.github_review_id.is_not(None),
        )
        .order_by(Review.created_at.desc())
        .limit(1)
    )


def publish_review(
    db: Session,
    review: Review,
    owner: str,
    repo_name: str,
    meta: PullRequestMeta,
    file_diffs,
    *,
    gh: GitHubClient,
    actor: User,
) -> None:
    """Post a completed review to its pull request. Never raises.

    Off by default (``settings.post_reviews_to_github``). **The flag is checked
    before any payload is built**, so with posting disabled nothing is computed
    and a caller holding a client that cannot write is never asked to.

    A failure here is recorded on the row and swallowed. The review is already
    complete — in the database, visible in the UI — and letting a GitHub 500
    flip it to ``failed`` would be strictly worse than not posting.
    """
    if not settings.post_reviews_to_github:
        return
    if review.status != "completed":
        return
    # Idempotency: never post the same Review row twice. `synchronize` webhooks
    # fire on every push and a re-review creates a new row, so without this a
    # PR pushed to five times accumulates five duplicate threads.
    if review.github_review_id is not None:
        return

    try:
        comments = list(
            db.scalars(
                select(ReviewComment)
                .where(ReviewComment.review_id == review.id)
                .order_by(ReviewComment.file_path, ReviewComment.line_start)
            )
        )
        postable, unanchorable = partition_comments(comments, file_diffs)
        event = resolve_event(
            review.verdict,
            # `User.username` is the GitHub login, and `meta.author` is the PR
            # author's. Case-insensitive: GitHub logins are.
            is_own_pr=actor.username.lower() == (meta.author or "").lower(),
            mode=settings.github_review_event_mode,
        )
        body = build_review_body(
            review.summary,
            event=event,
            unanchorable=unanchorable,
            supersedes_url=_previous_posted_review_url(db, review),
        )

        posted = gh.create_pull_request_review(
            owner, repo_name, meta.number, body=body, event=event.event, comments=postable
        )
        review.github_review_id = posted.id
        review.github_review_url = posted.html_url
        review.posted_at = datetime.now(timezone.utc)
        review.post_error = None
        db.commit()
    except Exception as exc:  # noqa: BLE001 - a publish must never fail a review
        logger.warning(
            "posting review %s to %s/%s#%s failed: %s",
            review.id, owner, repo_name, meta.number, exc,
        )
        try:
            db.rollback()
            review.post_error = truncate_post_error(str(exc))
            db.commit()
        except Exception:
            # Recording *why* it failed must not itself fail the review either.
            logger.exception("could not record post_error for review %s", review.id)
            db.rollback()
