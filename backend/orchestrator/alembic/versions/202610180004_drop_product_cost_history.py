"""移除冗余的「产品成本历史」表

Revision ID: 202610180004
Revises: 202610180002
Create Date: 2026-10-18

用户 2026-10-18 裁决：**历史报价本身就是成本历史**，成本信息可以直接从
`quote_order_items`（`cost_override` + `spec_snapshot`，含完整产品参数）提取；
单建 `product_cost_history` 是多余设计，删除。

保留 002 中真正需要的部分：`customers.abbr`、`cust_inquiries.inquiry_no`。
"""
from typing import Sequence, Union

from alembic import op

revision: str = "202610180004"
down_revision: Union[str, None] = "202610180002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 002 已建过表；这里统一删除（fresh DB 也会走 002 → 004，DROP IF EXISTS 安全）
    op.execute("DROP TABLE IF EXISTS product_cost_history")


def downgrade() -> None:
    # 不再恢复：成本历史由历史报价承载；降级只回到 002 的其余结构。
    pass
