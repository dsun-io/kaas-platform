"""events_archive_log id default（生产缺失修复）

Revision ID: 202610210001
Revises: 202610200006
Create Date: 2026-10-21 00:40:00.000000

背景（2026-10-21 A8 归档首窗口排查）：
  生产 `events_archive_log.id` 是 uuid NOT NULL 但**没有默认值**（历史迁移
  `202605030001` 的 SET DEFAULT 在现网库未生效），worker 归档 INSERT 不带 id
  ⇒ `NotNullViolationError`，cron 归档重试 3 次全部失败但不抛穿、也不写日志行。
  这里补上 `gen_random_uuid()` 默认；worker 侧同时改为显式传 uuid 兜底。
"""
from typing import Sequence, Union

from alembic import op

revision: str = '202610210001'
down_revision: Union[str, None] = '202610200006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_attrdef d
            JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
            JOIN pg_class c ON c.oid = d.adrelid
            WHERE c.relname = 'events_archive_log' AND a.attname = 'id'
        ) THEN
            ALTER TABLE events_archive_log
                ALTER COLUMN id SET DEFAULT gen_random_uuid();
        END IF;
    END $$;
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE events_archive_log ALTER COLUMN id DROP DEFAULT;")
