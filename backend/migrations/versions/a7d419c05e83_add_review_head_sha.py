"""add review head_sha

What commit a review actually looked at.

Every re-review re-fetched the whole `base...head` diff and handed all of it to
the model, so pushing a one-line fix to a large pull request cost the same as
the first review of it — and the model spent most of its attention on ground it
had already covered. Nothing recorded where the last review stopped, so there
was nothing to review *from*.

`PullRequestMeta.head_sha` was already fetched on every run and thrown away.
This keeps it.

Nullable: every existing row predates it, and a review whose provider failed
before the metadata call has none. A null means "no idea what this one saw",
which correctly falls back to reviewing the whole diff.

Revision ID: a7d419c05e83
Revises: f0c3a91b47e2
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7d419c05e83"
down_revision: Union[str, None] = "f0c3a91b47e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 40 for a full SHA-1, which is what the API returns. Not sized for the
    # abbreviated form: an abbreviation that is unambiguous today can become
    # ambiguous as a repository grows, and this value is used to ask GitHub for
    # a comparison.
    op.add_column("reviews", sa.Column("head_sha", sa.String(40), nullable=True))


def downgrade() -> None:
    op.drop_column("reviews", "head_sha")
