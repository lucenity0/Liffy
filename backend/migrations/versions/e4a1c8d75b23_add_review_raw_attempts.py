"""add reviews.raw_attempts and reviews.dropped_comments

Both numbers have always been computed and always been thrown away.
``generate_review`` counts the attempts it needed before the output validated
and how many findings anchoring discarded, returns both on ``LLMResult``, and
nothing ever wrote them anywhere.

``raw_attempts`` is the cost side of a required field. ``failure_scenario`` is
mandatory, so a model that omits it burns a retry, then another, then fails the
review — and on ``claude_code`` and ``codex`` each attempt is a subprocess with
a 600s timeout. Without a column there is no distribution to look at, only
anecdotes: the figures in ADR 006 came from wrapping ``generate_review`` in a
throwaway script over three reviews.

Both nullable, with no backfill. Every review written before this predates the
instrumentation, and a 1 written into those rows would be a measurement nobody
took — the same reason ``duration_ms`` and ``total_ms`` are nullable on the rows
that predate METRIC-1. Null means "not recorded", which #273 has to be able to
tell apart from "recorded as 1".

Revision ID: e4a1c8d75b23
Revises: d7c92a4f6b18
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e4a1c8d75b23"
down_revision: Union[str, None] = "d7c92a4f6b18"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("reviews", sa.Column("raw_attempts", sa.Integer(), nullable=True))
    op.add_column("reviews", sa.Column("dropped_comments", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("reviews", "dropped_comments")
    op.drop_column("reviews", "raw_attempts")
