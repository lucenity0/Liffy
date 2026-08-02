"""Add reviews.summary_detail

The structured half of a review's overview — what the pull request does, and
what changed in each file — so the pull-request body and the detail panel can
render more than a paragraph.

Nullable with no backfill, deliberately. Every review written before this has a
prose summary and no structure, which is exactly what null means here; inventing
a `{"changes": [], "files": []}` for them would claim the model was asked and
answered nothing.

Revision ID: d4a2c8b19e73
Revises: b7e1d2f4a9c6
"""

import sqlalchemy as sa
from alembic import op

revision = "d4a2c8b19e73"
down_revision = "b7e1d2f4a9c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("reviews", sa.Column("summary_detail", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("reviews", "summary_detail")
