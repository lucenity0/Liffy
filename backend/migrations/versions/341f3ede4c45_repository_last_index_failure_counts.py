"""repository last index failure counts

Revision ID: 341f3ede4c45
Revises: 4cba78e280b3
Create Date: 2026-07-31 15:58:37.460801

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '341f3ede4c45'
down_revision: Union[str, None] = '4cba78e280b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable with no backfill, deliberately. Every repository already in the
    # database was indexed before these were recorded, and it genuinely has no
    # measurement — which is a different thing from having measured a zero.
    # Defaulting to 0 would tell the UI "this index is complete" about runs
    # nobody counted, which is the exact false-clean-chip this migration exists
    # to remove.
    op.add_column('repositories', sa.Column('last_index_failed_files', sa.Integer(), nullable=True))
    op.add_column('repositories', sa.Column('last_indexed_files_seen', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('repositories', 'last_indexed_files_seen')
    op.drop_column('repositories', 'last_index_failed_files')
