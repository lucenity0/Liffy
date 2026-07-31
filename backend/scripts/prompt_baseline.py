"""Run Liffy's real review pipeline over a fixed set of PRs and record the output.

PROMPT-1 (#202) needs a *comparable* before-and-after, which means the only
thing allowed to differ between two runs is ``prompts.py``. So this script
pins everything else: the same PRs, the same repository index, the same
provider, the same retrieval budget.

    python scripts/prompt_baseline.py before
    # …change one thing in prompts.py…
    python scripts/prompt_baseline.py after

Writes ``docs/prompt-eval/<label>.json``. The artifacts are committed so a
later prompt change has a baseline to be compared against — without a recorded
one, "the prompt got better" is unfalsifiable.
"""

import json
import pathlib
import sys
import time

from sqlalchemy import select
from sqlalchemy.orm import Session

import app.models  # noqa: F401
from app.config import settings
from app.database import SessionLocal
from app.llm.chain import get_llm
from app.llm.embeddings import get_embedding_provider
from app.models.repository import Repository
from app.models.review_comment import ReviewComment
from app.services.github_service import GitHubClient
from app.services.indexer import index_repository
from app.services.rag_service import get_chroma_client
from app.services.review_service import run_review

REPO_FULL_NAME = "lucenity0/Liffy"

# Chosen to differ from one another on purpose — one kind of PR would only
# teach us how Liffy reviews that kind. #58 is the anchor: it is the review
# already assessed on #164, so it is the one data point with a known answer.
PRS = [
    (58, "setup shell scripts + requirements split — the #164 anchor"),
    (203, "backend Python, a real bug fix (chunker registry KeyError)"),
    (204, "backend Python with real logic + a migration (METRIC-2)"),
    (185, "frontend TypeScript (protected routes + user menu)"),
    (211, "docs only — should produce approve with zero comments"),
]

OUT_DIR = pathlib.Path(__file__).resolve().parents[2] / "docs" / "prompt-eval"


def ensure_indexed(db: Session) -> Repository:
    """Index the repository once; both runs retrieve against the same vectors.

    Retrieval quality is a second variable, and the point of this exercise is
    to isolate the first.
    """
    repo = db.scalar(select(Repository).where(Repository.full_name == REPO_FULL_NAME))
    if repo is None:
        raise SystemExit("connect the repository first (see the script header)")
    if repo.indexed_at is not None:
        print(f"already indexed at {repo.indexed_at}")
        return repo

    print("indexing… (once; this takes a few minutes)")
    gh = GitHubClient()
    try:
        result = index_repository(
            db, repo, gh=gh,
            chroma_client=get_chroma_client(), embedder=get_embedding_provider(),
        )
    finally:
        gh.close()
    print(f"  indexed: {result}")
    return repo


def main(label: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    db = SessionLocal()
    try:
        ensure_indexed(db)

        runs = []
        for number, why in PRS:
            print(f"\n── PR #{number}: {why}")
            started = time.monotonic()
            gh = GitHubClient()
            try:
                review = run_review(
                    db, "lucenity0", "Liffy", number,
                    gh=gh,
                    chroma_client=get_chroma_client(),
                    embedder=get_embedding_provider(),
                    llm=get_llm(),
                )
            except Exception as exc:
                print(f"  FAILED: {type(exc).__name__}: {exc}")
                runs.append({"pr": number, "why": why, "error": f"{type(exc).__name__}: {exc}"})
                continue
            finally:
                gh.close()

            comments = list(
                db.scalars(
                    select(ReviewComment)
                    .where(ReviewComment.review_id == review.id)
                    .order_by(ReviewComment.file_path, ReviewComment.line_start)
                )
            )
            record = {
                "pr": number,
                "why": why,
                "verdict": review.verdict,
                "summary": review.summary,
                "tokens_used": review.tokens_used,
                "duration_ms": review.duration_ms,
                "wall_s": round(time.monotonic() - started, 1),
                "model_used": review.model_used,
                "comment_count": len(comments),
                "comments": [
                    {
                        "file": c.file_path,
                        "line_start": c.line_start,
                        "line_end": c.line_end,
                        "category": c.category,
                        "severity": c.severity,
                        "comment": c.comment_text,
                        "suggestion": c.suggestion,
                        # Filled in by hand: correct | false | unverifiable.
                        # The three-way split #164 used — "unverifiable" is a
                        # distinct failure from "wrong", and collapsing them
                        # loses the thing worth fixing.
                        "assessment": None,
                    }
                    for c in comments
                ],
            }
            runs.append(record)
            print(
                f"  verdict={review.verdict} comments={len(comments)} "
                f"tokens={review.tokens_used} {record['wall_s']}s"
            )

        payload = {
            "label": label,
            "provider": settings.llm_provider,
            "model": (
                settings.claude_code_model
                if settings.llm_provider == "claude_code"
                else settings.anthropic_model
            ),
            "effort": settings.anthropic_effort,
            "max_context_chunks": 10,
            "runs": runs,
        }
        path = OUT_DIR / f"{label}.json"
        path.write_text(json.dumps(payload, indent=2) + "\n")
        print(f"\nwrote {path}")
    finally:
        db.close()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "before")
