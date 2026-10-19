"""移除冗余的「产品成本历史」表

Revision ID: 202610180004
Revises: 202610180002
Create Date: 2026-10-18

用户 2026-10-18 裁决：**历史报价本身就是成本历史**，成本信息可以直接从
`quote_order_items`（`cost_override` + `spec_snapshot`，含完整产品参数）提取；
单建 `product_cost_history` 是多余设计，删除。

保留 002 中真正需要的部分：`customers.abbr`、`cust_inquiries.inquiry_no`。

2026-10-19 修复：downgrade 原先直接 `pass`，导致 `alembic downgrade base` 在
002 的 downgrade 处报 `index "idx_product_cost_history_spec" does not exist`
（004 已把表删掉，002 却还要 drop 它的索引）。修复后 downgrade 会按 002 的
upgrade 形态**重建**该表与两个索引，保证『降级到 002』时 schema 自洽；
002 的 downgrade 也改为 IF EXISTS 形式，容忍历史手工漂移。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "202610180004"
down_revision: Union[str, None] = "202610180002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 002 已建过表；这里统一删除（fresh DB 也会走 002 → 004，DROP IF EXISTS 安全）
    op.execute("DROP TABLE IF EXISTS product_cost_history")


def downgrade() -> None:
    # 恢复 002 的产物（表 + 两个索引），否则 002 的 downgrade 会因为找不到索引而失败。
    op.create_table(
        "product_cost_history",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("team_id", sa.BigInteger(),
                  sa.ForeignKey("teams.id", ondelete="SET NULL"), nullable=True),
        sa.Column("product_key", sa.Text(), nullable=False),
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
