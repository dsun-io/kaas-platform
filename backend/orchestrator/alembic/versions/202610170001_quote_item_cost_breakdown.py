"""报价行项内部分解快照（成本/利润）—— 对内视图与历史参考价的数据地基

Revision ID: 202610170001
Revises: 202610120001
Create Date: 2026-10-17

背景（UNCERTAIN #19 · David 2026-10-17 口径）：
- 原料每日波动、实时报价；历史报价留痕走报价台账本身；
- 历史报价信息要全：客户/时间/报价人/产品/规格/数量/价格，
  **价格拆成本+利润、区分对内/对外双视图**（成本字段接口层鉴权，绝不透出对外单证）；
- 无今日行情时，从本列聚合「同客户同规格历史均价」作参考价。

`cost_breakdown`（JSONB，可空）：签发/保存时把算价引擎内部视图的分解一并落库
（成本、税费、利润、利润率等，形状由前端从 /export-quote/calculate 的
internal 视图带来）。NULL = 老数据无分解，对内视图显示「—」，参考价不受影响
（参考价聚合的是 `unit_price`，本列只做展示与核算）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202610170001"
down_revision: Union[str, None] = "202610120001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "quote_order_items",
        sa.Column("cost_breakdown", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("quote_order_items", "cost_breakdown")
