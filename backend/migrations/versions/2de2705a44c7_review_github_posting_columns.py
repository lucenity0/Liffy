"""review github posting columns

Revision ID: 2de2705a44c7
Revises: e381a8478c7f
Create Date: 2026-07-31 16:29:59.928034

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2de2705a44c7'
down_revision: Union[str, None] = 'e381a8478c7f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # All four nullable with no backfill: posting is opt-in and off by
    # default, so every existing review genuinely was never posted. NULL is
    # the honest value, and `github_review_id IS NULL` is what the
    # idempotency guard reads.
    op.add_column('reviews', sa.Column('github_review_id', sa.BigInteger(), nullable=True))
    op.add_column('reviews', sa.Column('github_review_url', sa.String(length=512), nullable=True))
    op.add_column('reviews', sa.Column('posted_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('reviews', sa.Column('post_error', sa.String(length=1024), nullable=True))


def downgrade() -> None:
    op.drop_column('reviews', 'post_error')
    op.drop_column('reviews', 'posted_at')
    op.drop_column('reviews', 'github_review_url')
    op.drop_column('reviews', 'github_review_id')
