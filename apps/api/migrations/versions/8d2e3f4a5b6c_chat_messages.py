"""chat messages

Revision ID: 8d2e3f4a5b6c
Revises: 7c1d2e3f4a5b
Create Date: 2026-10-24 20:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "8d2e3f4a5b6c"
down_revision: str | Sequence[str] | None = "7c1d2e3f4a5b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # Visitors' questions and organizers' answers, one thread per visitor.
    op.create_table(
        "chat_messages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("map_id", sa.Uuid(), nullable=False),
        sa.Column("thread", sa.Uuid(), nullable=False),
        sa.Column("author", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["map_id"], ["maps.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_chat_messages_map_id"), "chat_messages", ["map_id"], unique=False)
    op.create_index(op.f("ix_chat_messages_thread"), "chat_messages", ["thread"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_chat_messages_thread"), table_name="chat_messages")
    op.drop_index(op.f("ix_chat_messages_map_id"), table_name="chat_messages")
    op.drop_table("chat_messages")
