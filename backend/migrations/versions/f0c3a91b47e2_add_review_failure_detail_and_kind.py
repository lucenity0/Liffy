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


def downgrade() -> None:
    op.drop_column("reviews", "failure_kind")
    op.drop_column("reviews", "failure_detail")
