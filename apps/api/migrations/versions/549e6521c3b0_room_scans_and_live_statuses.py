"""room scans and live statuses

Revision ID: 549e6521c3b0
Revises: 85ce37ebece5
Create Date: 2026-10-24 01:51:10.492713

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "549e6521c3b0"
down_revision: str | Sequence[str] | None = "85ce37ebece5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # Live place statuses: one row per (map, poi), changed without republishing.
    op.create_table(
        "map_live",
        sa.Column("map_id", sa.Uuid(), nullable=False),
        sa.Column("poi_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("note", sa.String(length=140), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["map_id"], ["maps.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("map_id", "poi_id"),
    )
    # Room scans: the video lives in storage (scans/{id}/), the worker writes status and result.
    op.create_table(
        "room_scans",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("map_id", sa.Uuid(), nullable=False),
        sa.Column("level_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("camera_height_m", sa.Float(), nullable=False),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["map_id"], ["maps.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_room_scans_map_id"), "room_scans", ["map_id"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_room_scans_map_id"), table_name="room_scans")
    op.drop_table("room_scans")
    op.drop_table("map_live")
