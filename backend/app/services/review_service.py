"""End-to-end review orchestration (report §3.1 steps 10-12).

``run_review`` is the single entry point the Celery worker (BASE-9) calls:
fetch PR (BASE-3) -> parse diff (BASE-4) -> retrieve context (BASE-6) ->
generate (BASE-7) -> persist review + comments. All I/O dependencies are
injected, so the pipeline is testable offline.
"""

import logging
import sys
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.llm.chain import ReviewLLM, SubscriptionCLIError, generate_review
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
    llm: ReviewLLM | Callable[[], ReviewLLM],
    received_at: datetime | None = None,
    commit_shas: list[str] | None = None,
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
    review = Review(
        pr_id=pr.id,
        status="processing",
        raw_diff=raw_diff,
        # Recorded before any model call, so a review that dies mid-pipeline
        # still says what it was looking at — and so the *next* review of this
        # pull request can pick up from here even if this one failed.
        head_sha=meta.head_sha or None,
        queued_at=received_at,
    )
    db.add(review)
    db.commit()

    try:
        # Built *here*, inside the try, and not by the caller.
        #
        # Constructing the transport is the single likeliest thing to fail
        # before any work happens — a provider whose CLI is missing, a key that
        # is not set, a container without the credential. Evaluated as an
        # argument it raised before the row above existed, so the review left
        # no trace at all: the queue emptied, the reviews list stayed empty,
        # and the only evidence was a traceback in the worker log. The UI said
        # "queued" and then showed nothing, forever.
        #
        # Inside the try it lands on the failure path like everything else, and
        # the operator gets a failed review that names the cause.
        active_llm = llm() if callable(llm) else llm

        # Two diffs, deliberately, and they are not interchangeable.
        #
        # `file_diffs` is the whole pull request, and it is what comments are
        # anchored and posted against. GitHub only accepts an inline comment on
        # a line that appears in the pull request's own diff, so validating
        # against anything narrower risks a 422 that rejects the entire review
        # — a line touched in one commit and reverted in the next is in the
        # incremental diff and not in this one.
        #
        # `review_diffs` is what the model is shown. On a re-review that is
        # only what has landed since the last one, which is the whole point:
        # pushing a one-line fix to a large pull request used to cost the same
        # as reviewing it from scratch.
        file_diffs = parse_diff(raw_diff)
        review_diffs, since = _diffs_to_review(
            gh, owner, repo_name, db, pr.id, review, meta, file_diffs,
            automatic=received_at is not None,
            commit_shas=commit_shas,
        )

        # Retrieval follows what is being reviewed, not the whole pull request.
        # Embedding twenty unchanged files to review one changed line is the
        # same waste in a different currency.
        context = _gather_context(chroma_client, repo.id, review_diffs, embedder)
        result = generate_review(
            active_llm,
            meta.title,
            review_diffs,
            context,
            prior_findings=_prior_findings(db, pr.id, review) if since else [],
        )

        # Comments arrive already filtered and clamped to the diff by
        # `_anchor_comments` in the LLM chain, so no anchor check is repeated
        # here. That guard cannot catch #227's failure — see its docstring.
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
        # Stored only when the model actually produced it: null means "not
        # asked or not answered", which is true of every review written before
        # this existed and of any model that returned the older output shape.
        review.summary_detail = (
            {
                "changes": result.output.changes,
                "files": [
                    {"path": f.path, "description": f.description}
                    for f in result.output.files
                ],
            }
            if (result.output.changes or result.output.files)
            else None
        )
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
        # Why it failed, where somebody will actually see it.
        #
        # There is no dedicated column and adding one is a migration; `summary`
        # is already rendered for every review, and a failed review has no
        # summary to displace. "Failed" on its own sends people to the worker
        # log — which is exactly the trip this is meant to save. Provider and
        # configuration errors are the common case here and none of them carry
        # a credential, but the text is truncated regardless.
        exc = sys.exc_info()[1]
        review.summary = f"Review failed: {str(exc)[:400]}"

        # The raw provider output and whether the reader can act on it.
        #
        # A bug in our own code has neither and lands as `unknown`, which is
        # the honest answer: we cannot say how to fix it, so the UI offers a
        # report instead of advice.
        #
        # `isinstance`, not `getattr(exc, "detail", ...)`.
        #
        # `detail` is a common attribute name — `fastapi.HTTPException` carries
        # one that can be a dict or a list — and assigning that to a Text
        # column raises a second exception *inside* the failure handler, which
        # loses the record entirely. The handler has to be total: whatever went
        # wrong, a row describing it must survive.
        if isinstance(exc, SubscriptionCLIError):
            review.failure_detail = exc.detail
            review.failure_kind = exc.kind
        elif isinstance(exc, OSError):
            # A dependency was unreachable rather than misconfigured — the
            # recorded `[Errno 111] Connection refused` is this. Without this
            # branch `infra` was documented in three places and produced by
            # none, so `FIXES.infra` in the UI was unreachable code.
            review.failure_kind = "infra"
        else:
            review.failure_kind = "unknown"
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


def _last_reviewed_sha(db: Session, pr_id: uuid.UUID, review: Review) -> str | None:
    """The commit the previous *completed* review of this PR looked at.

    Completed, not merely latest: a review that failed said nothing about the
    code, so diffing from it would skip commits nobody has ever looked at.
    That is the difference between a cheaper review and a review with a hole
    in it.
    """
    return db.scalar(
        select(Review.head_sha)
        .where(
            Review.pr_id == pr_id,
            Review.id != review.id,
            Review.status == "completed",
            Review.head_sha.is_not(None),
        )
        .order_by(Review.created_at.desc())
        .limit(1)
    )


def _diffs_to_review(
    gh, owner: str, repo_name: str, db: Session, pr_id: uuid.UUID,
    review: Review, meta, file_diffs, *, automatic: bool,
    commit_shas: list[str] | None = None,
):
    """What to show the model, and whether it is an increment.

    Returns ``(diffs, since_sha)``. ``since_sha`` is ``None`` when the whole
    pull request is being reviewed, which is the first review, every review a
    person asked for by hand, and every failure path below.

    **Only automatic reviews are narrowed**, and that split is the answer to
    what narrowing costs. Reviewing an increment means each hunk gets looked at
    once, where before every pass re-read everything and a later pass could
    catch what an earlier one missed. That redundancy was accidental, but it
    was doing real work — on this repository's own #274, passes two and three
    each found defects that had been present and unremarked during pass one.

    So a push gets the cheap check, and a person clicking Re-review gets the
    whole pull request. A miss is never permanent, and the escape hatch is the
    button already labelled for it.

    **Every failure here falls back to the full diff rather than raising.**
    This is an optimisation; a pull request that cannot be compared — a
    force-push that orphaned the old commit, a 404, an API blip — still
    deserves a review, and getting an expensive one is a far better outcome
    than getting none.
    """
    if commit_shas:
        # The commit picker: somebody named which commits are worth looking at.
        #
        # The selection chooses *files*, and those files are reviewed as they
        # stand at the pull request's head rather than as the chosen commits
        # left them. Skipping a commit in the middle therefore cannot produce a
        # stale line number, and a file touched by both a chosen and an unchosen
        # commit is read whole — which is also why this filters `file_diffs`
        # rather than fetching a diff of its own.
        try:
            paths = set(gh.list_files_in_commits(owner, repo_name, commit_shas))
        except Exception as exc:  # noqa: BLE001 - never fail a review over this
            logger.warning(
                "could not resolve files for %d commit(s) on %s/%s#%s, "
                "reviewing the whole diff: %s",
                len(commit_shas), owner, repo_name, meta.number, exc,
            )
            return file_diffs, None

        chosen = [fd for fd in file_diffs if fd.path in paths]
        if not chosen:
            # The chosen commits touched nothing that survives in the pull
            # request's diff — reverted, or entirely outside it. Reviewing
            # everything is wrong, but reviewing nothing is worse.
            logger.info(
                "selected commits touch no file in the diff of %s/%s#%s, "
                "reviewing the whole diff",
                owner, repo_name, meta.number,
            )
            return file_diffs, None

        logger.info(
            "reviewing %d of %d file(s) on %s/%s#%s, chosen via %d commit(s)",
            len(chosen), len(file_diffs), owner, repo_name, meta.number,
            len(commit_shas),
        )
        return chosen, None

    if not automatic:
        # Asked for by a person: `received_at` is set only by the webhook, so
        # its absence means the trigger endpoint or the Re-review button. Both
        # mean "look at this properly", which an increment cannot answer.
        return file_diffs, None

    since = _last_reviewed_sha(db, pr_id, review)
    head = meta.head_sha or ""

    if not since or not head or since == head:
        # No predecessor, or nothing new since it. A re-review at the same
        # commit is a deliberate "look again", and narrowing it to an empty
        # diff would answer a request to re-read with silence.
        return file_diffs, None

    try:
        incremental = gh.get_comparison_diff(owner, repo_name, since, head)
    except Exception as exc:  # noqa: BLE001 - never fail a review over this
        logger.warning(
            "compare %s...%s failed on %s/%s#%s, reviewing the whole diff: %s",
            since[:8], head[:8], owner, repo_name, meta.number, exc,
        )
        return file_diffs, None

    incremental_diffs = parse_diff(incremental)
    if not incremental_diffs:
        # A comparison that parses to nothing means the change was not in the
        # code — a merge commit, a base-branch move. Reviewing the whole thing
        # is wrong here too, but silence is worse, and this is rare enough to
        # prefer the loud option.
        logger.info(
            "compare %s...%s on %s/%s#%s produced no file diffs, reviewing the whole diff",
            since[:8], head[:8], owner, repo_name, meta.number,
        )
        return file_diffs, None

    logger.info(
        "reviewing %s/%s#%s incrementally: %d file(s) since %s, instead of %d",
        owner, repo_name, meta.number, len(incremental_diffs), since[:8],
        len(file_diffs),
    )
    return incremental_diffs, since


def _prior_findings(db: Session, pr_id: uuid.UUID, review: Review) -> list[str]:
    """What the last completed review said, as one line each.

    An incremental review cannot see the code an earlier finding was about, so
    without this it would silently drop every unfixed issue — the reader would
    read "nothing to report" and believe the earlier findings had been
    addressed. They are passed as context so the review can say what is still
    outstanding in its summary.

    Not as inline comments: those anchor to lines in the diff being reviewed,
    and an earlier finding is by definition somewhere else.
    """
    previous = db.scalar(
        select(Review.id)
        .where(
            Review.pr_id == pr_id,
            Review.id != review.id,
            Review.status == "completed",
        )
        .order_by(Review.created_at.desc())
        .limit(1)
    )
    if previous is None:
        return []

    rows = db.execute(
        select(
            ReviewComment.file_path,
            ReviewComment.line_start,
            ReviewComment.severity,
            ReviewComment.comment_text,
        )
        .where(ReviewComment.review_id == previous)
        .order_by(ReviewComment.file_path, ReviewComment.line_start)
    ).all()

    return [
        f"{path}:{line} [{severity}] {text}"
        for path, line, severity, text in rows
    ]


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
        detail = review.summary_detail or {}
        body = build_review_body(
            review.summary,
            event=event,
            unanchorable=unanchorable,
            supersedes_url=_previous_posted_review_url(db, review),
            changes=list(detail.get("changes") or []),
            files=[
                (f.get("path", ""), f.get("description", ""))
                for f in (detail.get("files") or [])
                if f.get("path")
            ],
            comment_count=len(comments),
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
