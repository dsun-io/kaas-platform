"""询盘编号 + 客户缩写 + 成本历史

Revision ID: 202610180002
Revises: 202610180001
Create Date: 2026-10-18

对应《docs/QUOTE_PRODUCT_OPTIMIZATION_PLAN_2026-10-18.md》：
  · 需求 1：询盘编号 `国家ISO2-客户缩写-yyyyMMddHHmmss`
      - `customers.abbr`：客户缩写（2-6 位大写字母，可空，空时按客户名/客户 id 兜底）
      - `cust_inquiries.inquiry_no`：询盘编号（唯一；存量不回填）
  · 需求 11：`product_cost_history`：产品成本手输历史（参考成本来源）

需求 16 的「系统级产品租户停用」**复用既有** `tenant_workstation_products.is_enabled`
（已存在、带工位维度），不另建表。

全部为**新增**（不改既有列），旧数据读取路径保持兼容：
  · abbr / inquiry_no 可空；
  · 成本历史没有行时按产品定义/规格兜底。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "202610180002"
down_revision: Union[str, None] = "202610180001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. 客户缩写 + 询盘编号 ────────────────────────────────────────────
    op.add_column("customers", sa.Column("abbr", sa.Text(), nullable=True))
    op.add_column("cust_inquiries", sa.Column("inquiry_no", sa.Text(), nullable=True))
    # PG 的唯一索引允许多个 NULL（存量询盘不补号，不冲突）
    op.create_index(
        "uq_cust_inquiries_inquiry_no",
        "cust_inquiries",
        ["inquiry_no"],
        unique=True,
        postgresql_where=sa.text("inquiry_no IS NOT NULL"),
    )

    # ── 2. 产品成本历史 ──────────────────────────────────────────────────
    op.create_table(
        "product_cost_history",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("team_id", sa.BigInteger(),
                  sa.ForeignKey("teams.id", ondelete="SET NULL"), nullable=True),
        sa.Column("product_key", sa.Text(), nullable=False),
        # 规格快照 + 指纹：同产品同规格的"最近一次/中位数"都靠它匹配
        sa.Column("spec_snapshot", postgresql.JSONB(), nullable=True),
        sa.Column("spec_hash", sa.Text(), nullable=True),
        sa.Column("cost_pretax", sa.Numeric(18, 6), nullable=False),
        sa.Column("cost_incl", sa.Numeric(18, 6), nullable=True),
        sa.Column("currency", sa.Text(), nullable=False, server_default="CNY"),
        sa.Column("source", sa.Text(), nullable=False, server_default="quote"),
        sa.Column("quote_order_id", sa.BigInteger(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "idx_product_cost_history_lookup",
        "product_cost_history",
        ["tenant_id", "product_key", "created_at"],
    )
    op.create_index(
        "idx_product_cost_history_spec",
        "product_cost_history",
        ["tenant_id", "product_key", "spec_hash", "created_at"],
    )


def downgrade() -> None:
    # 2026-10-19：改成 IF EXISTS 形式 —— 生产库存在历史手工漂移（列/索引可能已被旁路改动），
    # 严格 `op.drop_*` 会让整条 downgrade 链在一个缺失对象上中断（实测报
    # `index "idx_product_cost_history_spec" does not exist`）。降级语义不变。
    op.execute("DROP INDEX IF EXISTS idx_product_cost_history_spec")
    op.execute("DROP INDEX IF EXISTS idx_product_cost_history_lookup")
    op.execute("DROP TABLE IF EXISTS product_cost_history")
    op.execute("DROP INDEX IF EXISTS uq_cust_inquiries_inquiry_no")
    op.execute("ALTER TABLE cust_inquiries DROP COLUMN IF EXISTS inquiry_no")
    op.execute("ALTER TABLE customers DROP COLUMN IF EXISTS abbr")

