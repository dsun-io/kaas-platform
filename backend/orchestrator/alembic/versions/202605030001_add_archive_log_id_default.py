"""add_archive_log_id_default

Revision ID: 202605030001
Revises: 202605020001
Create Date: 2026-05-03 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = '202605030001'
down_revision: Union[str, None] = '202605020001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
    ALTER TABLE events_archive_log
    ALTER COLUMN id SET DEFAULT gen_random_uuid();
    """)


def downgrade() -> None:
    op.execute("""
    ALTER TABLE events_archive_log
    ALTER COLUMN id DROP DEFAULT;
    """)
