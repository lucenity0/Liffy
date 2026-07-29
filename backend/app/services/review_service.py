"""End-to-end review orchestration (report §3.1 steps 10-12).

``run_review`` is the single entry point the Celery worker (BASE-9) calls:
fetch PR (BASE-3) -> parse diff (BASE-4) -> retrieve context (BASE-6) ->
generate (BASE-7) -> persist review + comments. All I/O dependencies are
injected, so the pipeline is testable offline.
"""

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


class RepositoryNotConnected(RuntimeError):
    """A review was requested for a repository nobody has connected.

    Raised instead of inventing an owner: before AUTH-4 a phantom system user
    absorbed these, which meant an unsolicited webhook could create rows in
    the database.
    """


def resolve_repo_owner(db: Session, full_name: str) -> uuid.UUID | None:
    """Which user a webhook-driven review belongs to.

    Nothing stops two users connecting the same repository — ``full_name`` has
    no unique constraint — and a webhook carries no user context to choose
    between them. First connector wins: it is deterministic, and it keeps the
    review attached to whoever set the integration up.
    """
    return db.scalar(
        select(Repository.user_id)
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
) -> Review:
    # Resolve the owner before spending a GitHub call: a review for a
    # repository nobody connected has no one to belong to.
    user_id = resolve_repo_owner(db, f"{owner}/{repo_name}")
    if user_id is None:
        raise RepositoryNotConnected(f"{owner}/{repo_name}")

    meta = gh.get_pull_request(owner, repo_name, pr_number)
    raw_diff = gh.get_pull_request_diff(owner, repo_name, pr_number)
    repo, pr = ensure_repo_and_pr(db, owner, repo_name, meta, user_id)

    # Commit the processing row first: a crash mid-pipeline leaves an
    # inspectable record, and the API can report status while we work.
    review = Review(pr_id=pr.id, status="processing", raw_diff=raw_diff)
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
        review.completed_at = datetime.now(timezone.utc)
        db.commit()
        return review
    except Exception:
        db.rollback()  # discard any partial comment rows
        review.status = "failed"
        review.completed_at = datetime.now(timezone.utc)
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
