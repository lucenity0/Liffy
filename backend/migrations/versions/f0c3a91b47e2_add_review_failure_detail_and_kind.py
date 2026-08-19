"""add review failure_detail and failure_kind

Splitting a failed review's message into the part a person reads and the part
a person debugs.

``reviews.summary`` was doing three jobs: the one-line description the UI
renders for every review, the failure record, and a 400-character cap. So a
rate-limited run reached the screen as a good plain-language sentence with
three hundred characters of ``{"is_error": true, "duration_api_ms": ...}``
welded onto the end of it, and there was nowhere else for that to go.

``failure_detail`` gives the raw output its own home, behind a disclosure in
the UI. ``failure_kind`` records whether the person reading can do anything
about it, which is what decides between showing them a fix and offering to
file a report.

Both nullable: every existing row predates them, and a successful review has
neither.

Existing rows are migrated rather than left behind. Without that step a
deployment that already has failures keeps the welded ``Output: {…}`` tail
inside ``summary`` and gets NULL in both new columns — so the panel renders raw
JSON in the sentence, shows no **View log**, and always falls through to the
"Report this" path. That is precisely the state this change exists to remove,
and it would be the state of every database except the one it was written on.

Revision ID: f0c3a91b47e2
Revises: d4a2c8b19e73
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f0c3a91b47e2"
down_revision: Union[str, None] = "d4a2c8b19e73"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("reviews", sa.Column("failure_detail", sa.Text(), nullable=True))
    op.add_column("reviews", sa.Column("failure_kind", sa.String(32), nullable=True))

    # The backfill below is PostgreSQL-only — `substring(x from 'regex')`,
    # `regexp_replace`, `~` and `ILIKE` are all its dialect. The two
    # `add_column` calls above are portable, so without this guard anyone
    # running `alembic upgrade head` against SQLite or MySQL fails on the data
    # step *after* the schema step and ends up half-migrated.
    #
    # Skipped rather than reimplemented: Postgres is what `docker-compose.yml`
    # runs and what `DATABASE_URL` defaults to, and the columns are nullable, so
    # on another backend the new panel degrades to the pre-migration behaviour
    # instead of breaking. A backfill nobody can run is worse than one that
    # says it did nothing.
    if op.get_bind().dialect.name != "postgresql":
        return

    # Split the welded messages. The old classifier appended the provider's
    # output to its own sentence as `Output: {…}`, so the boundary is findable
    # and this is a move rather than a guess.
    #
    # Guarded on the `Output: {` shape rather than on `status='failed'` alone,
    # which makes it idempotent and leaves alone the failures that never had a
    # tail — `'claude' is not on PATH` was always just a sentence.
    op.execute(
        r"""
        UPDATE reviews
           SET failure_detail = substring(summary from 'Output:\s*(\{.*)$'),
               summary = rtrim(regexp_replace(summary, 'Output:\s*\{.*$', ''))
         WHERE status = 'failed'
           AND summary ~ 'Output:\s*\{'
        """
    )

    # Then classify what is left, from the sentence, because the sentence is
    # all a historical row has. `unknown` is the fallback and the honest one:
    # it makes the panel offer a bug report rather than advice that may not
    # apply to a failure nobody has classified.
    op.execute(
        """
        UPDATE reviews
           SET failure_kind = CASE
                 WHEN summary ILIKE '%rate limit%'
                   OR summary ILIKE '%quota%'            THEN 'limit'
                 WHEN summary ILIKE '%not on PATH%'      THEN 'cli_missing'
                 WHEN summary ILIKE '%not authenticated%'
                   OR summary ILIKE '%not signed in%'    THEN 'auth'
                 WHEN summary ILIKE '%Connection refused%'
                   OR summary ILIKE '%Errno 111%'        THEN 'infra'
                 ELSE 'unknown'
               END
         WHERE status = 'failed'
           AND failure_kind IS NULL
        """
    )


def downgrade() -> None:
    # Same dialect guard as `upgrade`: `left()` is portable but there is
    # nothing to weld back on a backend where the backfill never ran.
    if op.get_bind().dialect.name == "postgresql":
        _weld_detail_back()

    op.drop_column("reviews", "failure_kind")
    op.drop_column("reviews", "failure_detail")


def _weld_detail_back() -> None:
    # Weld the detail back on before dropping it, so the downgrade loses
    # formatting rather than information. Without this, going back one revision
    # silently discards every failure's provider output — and on the rows this
    # migration split, that output exists nowhere else.
    #
    # Truncated to 300, which is what the format being restored actually held:
    # the old classifier appended `Output: {blob[:300]}`. Welding the uncapped
    # detail back would produce summaries longer than any row that existed
    # before this migration, in the column the reviews list renders for every
    # review — reintroducing a worse version of the problem the upgrade
    # removes.
    op.execute(
        """
        UPDATE reviews
           SET summary = summary || ' Output: ' || left(failure_detail, 300)
         WHERE failure_detail IS NOT NULL
           AND summary IS NOT NULL
        """
    )
