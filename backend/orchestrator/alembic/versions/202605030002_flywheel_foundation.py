"""flywheel_foundation

Revision ID: 202605030002
Revises: 202605030001
Create Date: 2026-05-03 16:00:00.000000

§3.7.13 飞轮地基表结构:
  - events 表 BIGSERIAL PK (§3.7.1)
  - quotations / customer_capabilities 加 schema_version 列
  - events_archive_log 幂等创建
"""
from typing import Sequence, Union

from alembic import op

revision: str = '202605030002'
down_revision: Union[str, None] = '202605030001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Drop old partitioned events table (early dev, no prod data)
    op.execute("DROP TABLE IF EXISTS events CASCADE")

    # 2. Create new events table (BIGSERIAL PK, §3.7.1)
    op.execute("""
    CREATE TABLE events (
        id BIGSERIAL PRIMARY KEY,
        schema_version INT NOT NULL DEFAULT 1,
        tenant_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_source TEXT NOT NULL,
        actor_id TEXT,
        session_id TEXT,
        payload JSONB NOT NULL,
        trace_id TEXT,
        sampled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    # 3. Indexes (§3.7.1)
    op.execute(
        "CREATE INDEX idx_events_tenant_type_time "
        "ON events (tenant_id, event_type, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX idx_events_session "
        "ON events (session_id) WHERE session_id IS NOT NULL"
    )

    # 4. quotations / customer_capabilities — conditionally add schema_version
    op.execute("""
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'quotations') THEN
            ALTER TABLE quotations ADD COLUMN IF NOT EXISTS schema_version INT NOT NULL DEFAULT 1;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_capabilities') THEN
            ALTER TABLE customer_capabilities ADD COLUMN IF NOT EXISTS schema_version INT NOT NULL DEFAULT 1;
        END IF;
    END $$;
    """)

    # 6. events_archive_log — 幂等创建
    op.execute("""
    CREATE TABLE IF NOT EXISTS events_archive_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id VARCHAR(32) NOT NULL,
        month VARCHAR(7) NOT NULL,
        minio_path VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL,
        archived_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS events CASCADE")
    op.execute("""
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'quotations') THEN
            ALTER TABLE quotations DROP COLUMN IF EXISTS schema_version;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_capabilities') THEN
            ALTER TABLE customer_capabilities DROP COLUMN IF EXISTS schema_version;
        END IF;
    END $$;
    """)
    op.execute("DROP TABLE IF EXISTS events_archive_log")
