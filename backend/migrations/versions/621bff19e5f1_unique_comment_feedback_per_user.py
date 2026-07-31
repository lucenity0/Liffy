"""unique comment feedback per user

Revision ID: 621bff19e5f1
Revises: e381a8478c7f
Create Date: 2026-07-31 11:20:41.336127

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '621bff19e5f1'
down_revision: Union[str, None] = 'e381a8478c7f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # One rating per (comment, user). Without it a user who clicks thumbs-up
    # and then thumbs-down leaves two rows that both count, and every approval
    # rate computed off this table is wrong from then on with nothing to say so.
    #
    # No data migration to dedupe first: the table has never been written to —
    # the POST handler answered `{"status": "saved"}` without touching the
    # database until this revision's issue — so there are no existing rows for
    # the constraint to reject.
    op.create_unique_constraint(
        'uq_comment_feedback_comment_user',
        'comment_feedback',
        ['comment_id', 'user_id'],
    )


def downgrade() -> None:
    op.drop_constraint(
        'uq_comment_feedback_comment_user',
        'comment_feedback',
        type_='unique',
    )
