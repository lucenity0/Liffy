"""add pull_requests.merged_at

`pull_requests.status` carries GitHub's own vocabulary — `open` or `closed`,
with nothing in between — so a pull request merged cleanly and one closed
without merging are indistinguishable in the database today. The severity
calibration audit reads that column, and its footnote has been telling readers
that GitHub's API cannot tell the two apart.

It can. `merged_at` is on the pull request payload, on the single-PR endpoint,
and on the list endpoint. Nothing was ever reading it.

Nullable, and null is not "unknown": an open pull request has not been merged
and one closed without merging never will be. Both are honestly null, which is
why there is no server default and no backfill in this migration — the worker
that re-syncs state is what fills these in for existing rows, from GitHub,
rather than this file guessing.

Revision ID: d7c92a4f6b18
Revises: c1f4b7a20e93
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d7c92a4f6b18"
down_revision: Union[str, None] = "c1f4b7a20e93"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "pull_requests",
        sa.Column("merged_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("pull_requests", "merged_at")
