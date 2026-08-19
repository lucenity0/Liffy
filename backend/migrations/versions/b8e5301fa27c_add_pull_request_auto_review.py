"""add pull_requests.auto_review

Whether a push to this pull request should review it automatically.

`synchronize` — GitHub's event for "commits were pushed" — has always queued a
review, so applying three of Liffy's own suggestions cost three full reviews,
and a two-line README commit cost the same as a real change. On a subscription
that is rate-limit quota, spent without anyone asking for it.

Per pull request rather than per repository, because the risk is per pull
request: it depends whose PR it is and how active the author is. A repo-wide
switch cannot express "automatic on mine, never on the one where somebody is
pushing forty commits".

Defaults to false. A first review still happens automatically on `opened` —
that is the one nobody has to ask for, and it is what makes the tool feel
present without it spending anything further on its own.

Revision ID: b8e5301fa27c
Revises: a7d419c05e83
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b8e5301fa27c"
down_revision: Union[str, None] = "a7d419c05e83"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # `server_default` as well as a Python default: existing rows need a value,
    # and the webhook reads this column on a row it may not have written.
    op.add_column(
        "pull_requests",
        sa.Column(
            "auto_review",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("pull_requests", "auto_review")
