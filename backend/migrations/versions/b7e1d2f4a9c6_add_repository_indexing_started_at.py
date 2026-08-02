"""add repository indexing in-flight marker

Revision ID: b7e1d2f4a9c6
Revises: a3f81c47d2b0
Create Date: 2026-08-02 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7e1d2f4a9c6"
down_revision: Union[str, None] = "a3f81c47d2b0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "repositories",
        sa.Column("indexing_started_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("repositories", "indexing_started_at")
