"""map password

Revision ID: 9e4f5a6b7c8d
Revises: 8d2e3f4a5b6c
Create Date: 2026-10-25 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9e4f5a6b7c8d"
down_revision: str | Sequence[str] | None = "8d2e3f4a5b6c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # "password" maps: the hash of the password visitors type to open the map.
    op.add_column("maps", sa.Column("access_password_hash", sa.String(length=255), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("maps", "access_password_hash")
