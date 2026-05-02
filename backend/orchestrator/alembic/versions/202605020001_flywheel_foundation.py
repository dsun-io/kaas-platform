"""flywheel_foundation

Revision ID: 202605020001
Revises: 
Create Date: 2026-05-02 22:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '202605020001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # events table with partitioning
    op.execute("""
    CREATE TABLE events (
        id UUID NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL,
        trace_id VARCHAR(64) NOT NULL,
        route_version VARCHAR(10) NOT NULL,
        tenant_id VARCHAR(32) NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        schema_version VARCHAR(10) NOT NULL,
        payload JSONB NOT NULL,
        sampled BOOLEAN NOT NULL DEFAULT FALSE,
        source VARCHAR(64) NOT NULL,
        PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at);
    """)

    op.execute("""
    CREATE TABLE events_2026_05 PARTITION OF events
    FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
    """)

    op.execute("""
    CREATE TABLE events_2026_06 PARTITION OF events
    FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
    """)

    # events_archive_log table
    op.execute("""
    CREATE TABLE events_archive_log (
        id UUID PRIMARY KEY,
        tenant_id VARCHAR(32) NOT NULL,
        month VARCHAR(7) NOT NULL,
        minio_path VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL,
        archived_at TIMESTAMP WITH TIME ZONE NOT NULL
    );
    """)

    # Indexes
    op.execute("CREATE INDEX ix_events_tenant_id_created_at ON events (tenant_id, created_at);")
    op.execute("CREATE INDEX ix_events_trace_id ON events (trace_id);")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS events_archive_log;")
    op.execute("DROP TABLE IF EXISTS events CASCADE;")
