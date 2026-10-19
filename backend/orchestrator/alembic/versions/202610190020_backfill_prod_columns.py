"""补齐生产已有、迁移链缺失的列（2026-10-19 列级漂移门禁发现）

背景
----
`scripts/check-schema-drift.py` 用生产列快照比对 ORM metadata，发现两处不一致，
且**迁移链本身也缺这些列**（生产是历史手工/旁路加的）：

- `market_ports.created_at` / `market_ports.updated_at`
- `trade_docs.owner_id` / `trade_docs.owner_scope`

后果（本轮实测）：
- 全新库无论走「空库快径（create_all）」还是「迁移链（alembic upgrade head）」，
  这些表都缺列 ⇒ worker 的单证/港口查询在新环境必 500；
- `alembic check` 会持续报 “new upgrade operations”。

为什么是幂等 SQL
----------------
生产库**已经有**这些列（证据：生产 information_schema 快照
`scripts/prod-schema-columns.json`）。普通 `op.add_column` 在 deploy 的 migrate 作业里
会因 “column already exists” 直接失败 ⇒ 用 `DO $$ ... IF NOT EXISTS ...` 条件加列，
让「已加过的生产」和「没加过的全新库」都能通过。

Revision ID: 202610190020
Revises: 202610180010
"""
from typing import Sequence, Union

from alembic import op

revision: str = "202610190020"
down_revision: Union[str, None] = "202610180010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _add_column_if_missing(table: str, column: str, ddl: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = '{table}'
                  AND column_name = '{column}'
            ) THEN
                ALTER TABLE public.{table} ADD COLUMN {column} {ddl};
            END IF;
        END $$;
        """
    )


def _drop_column_if_exists(table: str, column: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = '{table}'
                  AND column_name = '{column}'
            ) THEN
                ALTER TABLE public.{table} DROP COLUMN {column};
            END IF;
        END $$;
        """
    )


def upgrade() -> None:
    _add_column_if_missing(
        "market_ports", "created_at", "timestamp with time zone NOT NULL DEFAULT now()"
    )
    _add_column_if_missing(
        "market_ports", "updated_at", "timestamp with time zone NOT NULL DEFAULT now()"
    )
    _add_column_if_missing("trade_docs", "owner_id", "text NULL")
    _add_column_if_missing(
        "trade_docs", "owner_scope", "text NOT NULL DEFAULT 'private'"
    )


def downgrade() -> None:
    _drop_column_if_exists("trade_docs", "owner_scope")
    _drop_column_if_exists("trade_docs", "owner_id")
    _drop_column_if_exists("market_ports", "updated_at")
    _drop_column_if_exists("market_ports", "created_at")
