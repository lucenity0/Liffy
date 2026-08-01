"""add settings table

Runtime overrides for app.config, so a new developer can pick a model and turn
GitHub posting on without opening .env (SETTINGS-1, #236).

Sparse: a row exists only for a setting somebody has changed. The resolver
honours a row only if the key is on EDITABLE_SETTINGS, so this table being
writable does not make it authoritative.

Revision ID: a3f81c47d2b0
Revises: 2de2705a44c7
Create Date: 2026-08-01 13:02:41.118204

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a3f81c47d2b0'
down_revision: Union[str, None] = '2de2705a44c7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'settings',
        sa.Column('key', sa.String(length=64), nullable=False),
        sa.Column('value', sa.Text(), nullable=False),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column('updated_by', sa.Uuid(), nullable=True),
        # SET NULL rather than CASCADE: deleting a user should lose the
        # attribution, not the setting they changed.
        sa.ForeignKeyConstraint(
            ['updated_by'], ['users.id'],
            name=op.f('fk_settings_updated_by_users'),
            ondelete='SET NULL',
        ),
        sa.PrimaryKeyConstraint('key', name=op.f('pk_settings')),
    )


def downgrade() -> None:
    op.drop_table('settings')
