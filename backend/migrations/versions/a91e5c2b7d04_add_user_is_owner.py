"""add is_owner to users

Revision ID: a91e5c2b7d04
Revises: e4a1c8d75b23
Create Date: 2026-08-23 11:04:22.117903

Liffy is single-tenant (ADR 007). This is the column that makes that real: the
first account to complete the OAuth handshake claims the instance, and the
settings page — which decides where the code being reviewed is sent — answers
403 to everybody else.

**Backfill matters here.** On an instance that already has users, adding the
column with a `false` default leaves nobody as owner, and the next login by
*anyone* would claim it. So the oldest account is promoted on upgrade: on a
single-user install that is the person who set it up, and on any other it is
the closest thing to a defensible answer without asking a question a migration
cannot ask.

**Existing multi-user installs lose sign-in on upgrade.** Every account other
than the promoted one is refused at the OAuth callback from here on, unless it
is listed in `ALLOWED_GITHUB_LOGINS`. That is the intent (ADR 007) rather than
a side effect, but it happens silently at the next login rather than here — so
if more than one person uses this instance, set that variable before upgrading.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a91e5c2b7d04'
down_revision: Union[str, None] = 'e4a1c8d75b23'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'users',
        sa.Column(
            'is_owner',
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    # The oldest account, and only if there is no owner already — so re-running
    # this after a manual promotion cannot produce a second one.
    #
    # `id IN (SELECT ...)` rather than `ORDER BY ... LIMIT 1` on the UPDATE
    # itself: Postgres does not accept LIMIT on an UPDATE, and this form runs
    # unchanged on both dialects.
    op.execute(
        """
        UPDATE users SET is_owner = true
        WHERE id IN (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner = true)
        """
    )

    # Partial, so it constrains only the owner row. A plain unique index would
    # allow exactly one *non*-owner, which is the opposite of the intent.
    op.create_index(
        'ix_users_single_owner',
        'users',
        ['is_owner'],
        unique=True,
        postgresql_where=sa.text('is_owner'),
        sqlite_where=sa.text('is_owner'),
    )


def downgrade() -> None:
    op.drop_index('ix_users_single_owner', table_name='users')
    op.drop_column('users', 'is_owner')
