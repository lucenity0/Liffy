"""add review_comments.confidence and review_comments.failure_scenario

Two axes the review output has been collapsing into one.

`severity` answers "how bad is this if it is real". It has never answered "how
sure is the model that it is real", and those are the two things a reader
triages on independently — a critical finding the model is guessing at and one
it can trigger on demand currently render identically. `confidence` splits
them: `confirmed` / `plausible`.

`failure_scenario` is the concrete inputs or state that make a finding bite and
the wrong result they produce. The prompt has always *asked* for specificity,
which a model satisfies by sounding specific; a required field turns the ask
into a filter.

Both land here **inert**. Nothing writes a non-null value and nothing reads
them until the issues that elicit them from the model land on top. Storage once,
in one migration, rather than two issues colliding on the same table.

Both nullable, and that is not a matter of taste. Every existing `review_comments`
row predates both columns, so `NOT NULL` without a server default fails the
migration on any non-empty database — and a server default would stamp a
confidence and a scenario onto historical rows that nothing ever elicited,
which is worse than admitting they are unknown. Null means "not asked or not
answered", and #273 has to be able to tell that from a real value.

`String(16)` for `confidence` matches the existing `severity` column beside it
and holds both values with room to spare. `failure_scenario` is model prose of
no fixed length, so `Text`, matching `comment_text`.

Revision ID: c1f4b7a20e93
Revises: b8e5301fa27c
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c1f4b7a20e93"
down_revision: Union[str, None] = "b8e5301fa27c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "review_comments",
        sa.Column("confidence", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "review_comments",
        sa.Column("failure_scenario", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("review_comments", "failure_scenario")
    op.drop_column("review_comments", "confidence")
