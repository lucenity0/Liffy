"""GET /analytics/summary (EVAL-5, report §8.1).

The two tests that matter most are ``test_summary_scoped_to_caller`` — this is
the widest-reaching read in the codebase and one forgotten join exposes
everybody's private repositories — and ``test_empty_account_returns_200``,
because an empty account is the state every new user is in.
"""

from datetime import datetime, timedelta, timezone

import pytest
from conftest import auth_headers, seed_user
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app
from app.models.comment_feedback import CommentFeedback
from app.models.eval_score import EvalScore
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.review_comment import ReviewComment
from app.models.user import User

client = TestClient(app)

T0 = datetime(2026, 7, 1, tzinfo=timezone.utc)
_seq = iter(range(1000, 9000))


@pytest.fixture()
def factory():
    engine = create_engine(
        "sqlite://", future=True, connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, autoflush=False)

    def override():
        db = sessions()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    yield sessions
    app.dependency_overrides.clear()


@pytest.fixture()
def db(factory):
    with factory() as session:
        yield session
        session.commit()


def _make_review(
    db,
    user: User,
    *,
    comments: list[tuple[str, str]] | None = None,
    status: str = "completed",
    tokens: int | None = None,
    duration_ms: int | None = None,
    total_ms: int | None = None,
    pr_status: str = "open",
    created_at: datetime | None = None,
) -> Review:
    """One repo + PR + review owned by ``user``. ``comments`` is (category, severity)."""
    n = next(_seq)
    repo = Repository(user_id=user.id, github_repo_id=n, full_name=f"{user.username}/r{n}")
    db.add(repo)
    db.flush()
    pr = PullRequest(
        repo_id=repo.id, github_pr_number=n, title="t", author=user.username,
        base_branch="main", head_branch="f", status=pr_status,
    )
    db.add(pr)
    db.flush()
    review = Review(
        pr_id=pr.id, status=status, summary="s", verdict="comment",
        tokens_used=tokens, duration_ms=duration_ms, total_ms=total_ms,
        created_at=created_at or T0,
    )
    db.add(review)
    db.flush()
    for i, (category, severity) in enumerate(comments or []):
        db.add(
            ReviewComment(
                review_id=review.id, file_path=f"a{i}.py", line_start=1, line_end=1,
                category=category, severity=severity, comment_text="c",
            )
        )
    db.flush()
    return review


def _rate(db, review: Review, user: User, ratings: list[int]) -> None:
    rows = list(
        db.scalars(
            select(ReviewComment)
            .where(ReviewComment.review_id == review.id)
            .order_by(ReviewComment.file_path)
        )
    )
    for comment, rating in zip(rows, ratings):
        db.add(CommentFeedback(comment_id=comment.id, user_id=user.id, rating=rating))
    db.flush()


def _summary(headers) -> dict:
    response = client.get("/analytics/summary", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


# ── Auth and the empty account ────────────────────────────────────────────────


def test_summary_unauthenticated_401(factory) -> None:
    assert client.get("/analytics/summary").status_code == 401


def test_empty_account_returns_200_with_nulls(db) -> None:
    """No repos, no reviews, no feedback.

    Written first on purpose: this is what a new user sees, and a 404 or a 500
    here reads as the page being broken rather than as an empty state.
    """
    user = seed_user(db, github_id=1, username="octo")
    db.commit()

    body = _summary(auth_headers(user))

    assert body["reviews_total"] == 0
    assert body["reviews_completed"] == 0
    assert body["reviews_failed"] == 0
    assert body["approval_rate"]["value"] is None
    assert body["false_positive_rate"]["value"] is None
    assert body["time_to_review_ms"]["value"] is None
    assert body["pipeline_duration_ms_median"] is None
    assert body["token_efficiency"] is None
    assert body["token_efficiency_series"] == []
    assert body["flagged_reviews"] == []
    assert body["flagged_reviews_total"] == 0
    # Not `{}` — the six categories still have a shape to render.
    assert len(body["category_distribution"]) == 6
    assert set(body["category_distribution"].values()) == {0}
    assert len(body["severity_calibration"]) == 3


def test_empty_account_reports_met_as_null_not_false(db) -> None:
    """Three states, not two. A rate nobody has produced is unknown, not missed.

    Collapsing them is how a fresh account renders as a failing one.
    """
    user = seed_user(db, github_id=1, username="octo")
    db.commit()

    body = _summary(auth_headers(user))

    assert body["approval_rate"]["met"] is None
    assert body["false_positive_rate"]["met"] is None
    assert body["time_to_review_ms"]["met"] is None


# ── Scoping — the data-leak test ──────────────────────────────────────────────


def test_summary_scoped_to_caller(db) -> None:
    """User A's numbers never include user B's, in either direction.

    This is the riskiest endpoint in the milestone: one forgotten join and a
    user sees aggregate data across everybody's private repositories.
    """
    alice = seed_user(db, github_id=1, username="alice")
    bob = seed_user(db, github_id=2, username="bob")

    for _ in range(5):
        _make_review(db, alice, comments=[("security", "critical")], tokens=1000)
    db.commit()

    alice_body = _summary(auth_headers(alice))
    bob_body = _summary(auth_headers(bob))

    assert alice_body["reviews_total"] == 5
    assert alice_body["category_distribution"]["security"] == 5
    assert bob_body["reviews_total"] == 0
    assert bob_body["category_distribution"]["security"] == 0

    # Now give Bob rated comments and confirm Alice's numbers do not move.
    bob_review = _make_review(db, bob, comments=[("logic_error", "warning")], tokens=1000)
    _rate(db, bob_review, bob, [-1])
    db.commit()

    assert _summary(auth_headers(alice))["approval_rate"]["value"] is None
    assert _summary(auth_headers(bob))["approval_rate"]["value"] == 0.0


def test_flagged_reviews_scoped_to_caller(db) -> None:
    """The flagged list comes from a different table and needs its own join."""
    alice = seed_user(db, github_id=1, username="alice")
    bob = seed_user(db, github_id=2, username="bob")
    theirs = _make_review(db, bob, comments=[("logic_error", "warning")])
    db.add(
        EvalScore(
            review_id=theirs.id, approval_rate=0.1, false_positive_rate=0.9, flagged=True
        )
    )
    db.commit()

    assert _summary(auth_headers(alice))["flagged_reviews"] == []
    assert _summary(auth_headers(alice))["flagged_reviews_total"] == 0
    assert len(_summary(auth_headers(bob))["flagged_reviews"]) == 1


# ── The five metrics ──────────────────────────────────────────────────────────


def test_summary_returns_all_five_metrics(db) -> None:
    user = seed_user(db, github_id=1, username="octo")
    review = _make_review(
        db, user, comments=[("logic_error", "critical")], tokens=1000,
        duration_ms=1000, total_ms=2000,
    )
    _rate(db, review, user, [1])
    db.commit()

    body = _summary(auth_headers(user))

    for key in (
        "approval_rate",
        "false_positive_rate",
        "category_distribution",
        "severity_calibration",
        "token_efficiency",
        "time_to_review_ms",
    ):
        assert key in body, key


def test_targets_included_in_response(db) -> None:
    """The page must not hardcode 0.70; §8.1's targets ship in the payload."""
    user = seed_user(db, github_id=1, username="octo")
    db.commit()

    body = _summary(auth_headers(user))

    assert body["approval_rate"]["target"] == 0.70
    assert body["approval_rate"]["comparison"] == "gt"
    assert body["false_positive_rate"]["target"] == 0.20
    assert body["false_positive_rate"]["comparison"] == "lt"
    assert body["time_to_review_ms"]["target"] == 90_000
    assert body["time_to_review_ms"]["comparison"] == "lt"


def test_approval_rate_pools_comments_not_reviews(db) -> None:
    """One review with 1 up, one with 1 up + 9 down.

    §8.1 says "% of comments", so the ratings pool: 2 positive out of 11 is
    **2/11 = 0.1818…**. (#194 quotes this case as "0.2, not 0.55" — 0.2 is that
    fraction rounded; 0.55 is the number the wrong method gives.)

    The wrong method is the mean of per-review rates: `(1.0 + 0.1) / 2 = 0.55`,
    which weights a one-comment review the same as a ten-comment one — so a
    single well-received nitpick outvotes a whole rejected review. Both are
    asserted, because the failure mode is landing on the plausible one.
    """
    user = seed_user(db, github_id=1, username="octo")
    small = _make_review(db, user, comments=[("logic_error", "warning")])
    _rate(db, small, user, [1])
    big = _make_review(db, user, comments=[("logic_error", "warning")] * 10)
    _rate(db, big, user, [1] + [-1] * 9)
    db.commit()

    body = _summary(auth_headers(user))

    assert body["approval_rate"]["value"] == pytest.approx(2 / 11)
    assert body["approval_rate"]["value"] != pytest.approx(0.55)
    assert body["approval_rate"]["sample_size"] == 11


def test_approval_rate_met_flag_tracks_the_target(db) -> None:
    user = seed_user(db, github_id=1, username="octo")
    review = _make_review(db, user, comments=[("logic_error", "warning")] * 4)
    _rate(db, review, user, [1, 1, 1, -1])  # 0.75 > 0.70
    db.commit()

    body = _summary(auth_headers(user))
    assert body["approval_rate"]["value"] == 0.75
    assert body["approval_rate"]["met"] is True
    # 0.25 is not < 0.20 — the two targets disagree on the same data, which is
    # exactly the contradiction ADR 004 documents.
    assert body["false_positive_rate"]["met"] is False


def test_category_distribution_has_all_six_keys(db) -> None:
    user = seed_user(db, github_id=1, username="octo")
    _make_review(db, user, comments=[("logic_error", "warning")])
    db.commit()

    dist = _summary(auth_headers(user))["category_distribution"]
    assert len(dist) == 6
    assert dist["security"] == 0


def test_severity_calibration_carries_sample_sizes(db) -> None:
    user = seed_user(db, github_id=1, username="octo")
    _make_review(db, user, comments=[("logic_error", "critical")])
    db.commit()

    rows = {r["severity"]: r for r in _summary(auth_headers(user))["severity_calibration"]}
    assert rows["critical"]["prs_with_comment"] == 1
    assert rows["info"]["prs_with_comment"] == 0
    assert rows["info"]["still_open_rate"] is None


# ── Durations ─────────────────────────────────────────────────────────────────


def test_median_duration_is_median_not_mean(db) -> None:
    """[100, 200, 100000] -> 200. One long retry must not move the number."""
    user = seed_user(db, github_id=1, username="octo")
    for ms in (100, 200, 100_000):
        _make_review(db, user, duration_ms=ms)
    db.commit()

    assert _summary(auth_headers(user))["pipeline_duration_ms_median"] == 200


def test_median_duration_ignores_null_rows(db) -> None:
    """Rows written before METRIC-1 are unmeasured, not instantaneous."""
    user = seed_user(db, github_id=1, username="octo")
    _make_review(db, user, duration_ms=None)
    _make_review(db, user, duration_ms=500)
    db.commit()

    assert _summary(auth_headers(user))["pipeline_duration_ms_median"] == 500


def test_time_to_review_uses_total_ms_and_reports_its_smaller_n(db) -> None:
    """§8.1's figure comes from `total_ms`, which is null without a webhook.

    Its sample size is therefore smaller than `reviews_completed` — often much
    smaller — which is why the n is in the response.
    """
    user = seed_user(db, github_id=1, username="octo")
    _make_review(db, user, duration_ms=1_000, total_ms=None)   # manual trigger
    _make_review(db, user, duration_ms=1_000, total_ms=50_000)  # webhook
    db.commit()

    body = _summary(auth_headers(user))
    assert body["time_to_review_ms"]["value"] == 50_000
    assert body["time_to_review_ms"]["sample_size"] == 1
    assert body["time_to_review_ms"]["met"] is True  # 50s < 90s
    assert body["reviews_total"] == 2


def test_time_to_review_misses_the_target_when_slow(db) -> None:
    user = seed_user(db, github_id=1, username="octo")
    _make_review(db, user, total_ms=120_000)
    db.commit()

    assert _summary(auth_headers(user))["time_to_review_ms"]["met"] is False


# ── Token efficiency ──────────────────────────────────────────────────────────


def test_token_efficiency_series_is_returned_oldest_first(db) -> None:
    user = seed_user(db, github_id=1, username="octo")
    older = _make_review(
        db, user, comments=[("logic_error", "warning")], tokens=10_000,
        created_at=T0,
    )
    newer = _make_review(
        db, user, comments=[("logic_error", "warning")], tokens=10_000,
        created_at=T0 + timedelta(days=1),
    )
    _rate(db, older, user, [1])
    _rate(db, newer, user, [-1])
    db.commit()

    series = _summary(auth_headers(user))["token_efficiency_series"]
    assert [p["review_id"] for p in series] == [str(older.id), str(newer.id)]
    assert series[0]["value"] == pytest.approx(0.1)


def test_token_efficiency_scalar_matches_the_series(db) -> None:
    user = seed_user(db, github_id=1, username="octo")
    review = _make_review(db, user, comments=[("logic_error", "warning")], tokens=10_000)
    _rate(db, review, user, [1])
    db.commit()

    body = _summary(auth_headers(user))
    assert body["token_efficiency"] == pytest.approx(
        sum(p["value"] for p in body["token_efficiency_series"])
        / len(body["token_efficiency_series"])
    )


# ── Review counts ─────────────────────────────────────────────────────────────


def test_review_counts_split_by_status(db) -> None:
    """The denominators the page needs to be honest about its own numbers."""
    user = seed_user(db, github_id=1, username="octo")
    _make_review(db, user, status="completed")
    _make_review(db, user, status="completed")
    _make_review(db, user, status="failed")
    _make_review(db, user, status="processing")
    db.commit()

    body = _summary(auth_headers(user))
    assert body["reviews_total"] == 4
    assert body["reviews_completed"] == 2
    assert body["reviews_failed"] == 1


# ── Flagged reviews ───────────────────────────────────────────────────────────


def test_flagged_reviews_listed_with_pr_context(db) -> None:
    user = seed_user(db, github_id=1, username="octo")
    review = _make_review(db, user, comments=[("logic_error", "warning")])
    db.add(
        EvalScore(
            review_id=review.id, approval_rate=0.25, false_positive_rate=0.75, flagged=True
        )
    )
    db.commit()

    flagged = _summary(auth_headers(user))["flagged_reviews"]
    assert len(flagged) == 1
    assert flagged[0]["review_id"] == str(review.id)
    assert flagged[0]["approval_rate"] == 0.25
    assert flagged[0]["repo_full_name"].startswith("octo/")
    assert isinstance(flagged[0]["pr_number"], int)


def test_unflagged_scores_are_not_listed(db) -> None:
    user = seed_user(db, github_id=1, username="octo")
    review = _make_review(db, user, comments=[("logic_error", "warning")])
    db.add(
        EvalScore(
            review_id=review.id, approval_rate=0.9, false_positive_rate=0.1, flagged=False
        )
    )
    db.commit()

    assert _summary(auth_headers(user))["flagged_reviews"] == []


def test_flagged_reviews_capped_and_total_reported(db) -> None:
    """25 flagged -> 20 returned, total 25.

    A silently truncated list reads as a complete one, so the true count has to
    travel with it.
    """
    user = seed_user(db, github_id=1, username="octo")
    for i in range(25):
        review = _make_review(db, user, comments=[("logic_error", "warning")])
        db.add(
            EvalScore(
                review_id=review.id, approval_rate=i / 100, false_positive_rate=0.5,
                flagged=True,
            )
        )
    db.commit()

    body = _summary(auth_headers(user))
    assert len(body["flagged_reviews"]) == 20
    assert body["flagged_reviews_total"] == 25
    # Worst first, so a truncated list keeps the ones most worth inspecting.
    rates = [f["approval_rate"] for f in body["flagged_reviews"]]
    assert rates == sorted(rates)
