"""报价单关联询盘（quote_orders.inquiry_id）

Revision ID: 202609270002
Revises: 202609270001

背景
----
业务上「一个客户一个询盘需要多种产品」——一次询盘是一张报价单，
这张报价单要能追回它是从哪个询盘来的：
  · 单证工位展示"来源询盘"并支持跳回上游；
  · 报价工位支持"为此询盘报价"（从询盘页带着客户与询盘 ID 进工作台）；
  · 一个询盘多次报价（改价重报）时，历史报价单仍各自挂在这个询盘上。

为什么用正列而不是关联表
------------------------
与 `trade_docs.order_id` 同一模式：这是**高频、单值**的上游引用
（一个询盘 : N 张报价单，但每张报价单只属于一个询盘），
正列可直接过滤、可建索引、免 JOIN；关联表适合多对多与语义标签，
这里用不上。列可空：历史报价单没有询盘来源，属正常情况。

只新增，不改动、不删除任何现有表与数据。

用法：cd backend/orchestrator && .venv\\Scripts\\python.exe -m alembic upgrade head
"""
from typing import Sequence, Union

from alembic import op

revision: str = "202609270002"
down_revision: Union[str, None] = "202609270001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 幂等：ADD COLUMN IF NOT EXISTS 让重复执行安全（本项目迁移链有历史缺陷，
    # 局部重放是常见操作，宁可让每一步都可重入）。
    op.execute("ALTER TABLE quote_orders ADD COLUMN IF NOT EXISTS inquiry_id BIGINT")
    # 列表按 (租户, 询盘) 过滤取该询盘的全部报价单
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_quote_orders_inquiry
            ON quote_orders (tenant_id, inquiry_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_quote_orders_inquiry")
    op.execute("ALTER TABLE quote_orders DROP COLUMN IF EXISTS inquiry_id")
