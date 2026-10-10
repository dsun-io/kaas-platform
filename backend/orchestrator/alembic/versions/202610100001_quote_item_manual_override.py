"""报价行项手动干预 + 多产品逐行计算上下文

Revision ID: 202610100001
Revises: 202609300001
Create Date: 2026-10-10

多产品报价 + 手动干预（对齐业务在用报价表的「手工单件成本/重量/体积」能力，
但改为按产品参数化而非通用手工字段）：

1. **逐行计算上下文**：多产品报价每一行可以带独立的报价政策覆盖
   （利润率、综合税费系数、成本口径等），互不影响。
   policy_override（JSONB）即行级上下文；空则继承报价单共享政策。

2. **手动干预 / 覆盖**：
   - price_source：auto（公式自动）| manual（非标产品手动给价）| overridden（覆盖）
   - cost_override / price_override / weight_override / volume_override：
     行级覆盖值，只影响该行的计算，不留痕到产品定义
   - manual_unit_price：非标产品直接给价（price_source=manual 时生效）

3. **产品图片**：行项可带图片引用（产品定义里的图，或本行特定图），
   单证渲染可选配图（如技术数据表）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202610100001"
down_revision: Union[str, None] = "202609300001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table in ("quote_order_items", "order_items"):
        op.add_column(table, sa.Column("policy_override", postgresql.JSONB(), nullable=True))
        op.add_column(
            table,
            sa.Column(
                "price_source",
                sa.Text(),
                nullable=False,
                server_default="auto",
            ),
        )
        op.add_column(table, sa.Column("cost_override", sa.Numeric(20, 6), nullable=True))
        op.add_column(table, sa.Column("price_override", sa.Numeric(20, 6), nullable=True))
        op.add_column(table, sa.Column("weight_override", sa.Numeric(20, 6), nullable=True))
        op.add_column(table, sa.Column("volume_override", sa.Numeric(20, 6), nullable=True))
        op.add_column(table, sa.Column("image_url", sa.Text(), nullable=True))


def downgrade() -> None:
    for table in ("quote_order_items", "order_items"):
        op.drop_column(table, "image_url")
        op.drop_column(table, "volume_override")
        op.drop_column(table, "weight_override")
        op.drop_column(table, "price_override")
        op.drop_column(table, "cost_override")
        op.drop_column(table, "price_source")
        op.drop_column(table, "policy_override")
