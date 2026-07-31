"""eval scores unique per review and flagged

Revision ID: 4cba78e280b3
Revises: 621bff19e5f1
Create Date: 2026-07-31 15:44:09.886571

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4cba78e280b3'
down_revision: Union[str, None] = '621bff19e5f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # `server_default='false'` and NOT NULL together, so the column is
    # backfillable in one statement and every existing row lands on a real
    # value rather than a NULL that reads as "not flagged" by accident.
    op.add_column('eval_scores', sa.Column('flagged', sa.Boolean(), server_default='false', nullable=False))
    # One row per review, so the weekly job can upsert. Without it a naive
    # insert grows a new row every Monday and "the latest score" becomes
    # ORDER BY computed_at DESC LIMIT 1 in every caller, forever.
    #
    # No dedupe pass first: the table has never been written to — nothing
    # computed eval_scores before this revision's issue — so there are no
    # duplicate review_ids for the constraint to reject.
    op.create_unique_constraint('uq_eval_scores_review', 'eval_scores', ['review_id'])


def downgrade() -> None:
    op.drop_constraint('uq_eval_scores_review', 'eval_scores', type_='unique')
    op.drop_column('eval_scores', 'flagged')
