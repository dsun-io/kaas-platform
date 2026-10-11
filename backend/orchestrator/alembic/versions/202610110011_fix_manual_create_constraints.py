"""纠正 010 初版留下的过严约束：不得挡住"手动新建 / 导入已有数据"

Revision ID: 202610110011
Revises: 202610110010
Create Date: 2026-10-11

问题
----
`010` 的**初版**在数据库上生效了两个过严约束：

    orders.ck_orders_from_quote      CHECK (quote_id IS NOT NULL)                     -- 订单必须有报价
    trade_docs.ck_doc_has_parent     CHECK (quote_id IS NOT NULL OR order_id IS NOT NULL) -- 单证必须有父对象

而业务明确要求：**支持手动新建订单/单证，支持导入系统里已有的数据**
（历史订单可能根本没走过报价流程；历史单证可能只记了客户和金额）。
这两个约束会把这类合法的用户操作**在数据库层直接拒绝** —— 必须去掉。

修正后的口径
------------
只保证「**单据必须归属业务客户**」：

    orders.ck_orders_has_customer      CHECK (customer_id IS NOT NULL)
    trade_docs.ck_docs_has_customer    CHECK (customer_id IS NOT NULL)
    trade_docs.ck_doc_single_parent    CHECK (quote_id IS NULL OR order_id IS NULL)  -- 保留

全部 `NOT VALID`：历史行豁免、新行必须满足。

幂等
----
先 `DROP CONSTRAINT IF EXISTS` 再 ADD —— 因此无论目标库上是"010 初版"还是"010 修正版"，
跑完本迁移的结果都一致（全新库先跑修正版 010 也不会撞重复约束）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110011"
down_revision: Union[str, None] = "202610110010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 过严的旧约束（要拆掉）+ 修正后的同名约束（先拆后建，保证幂等）
DROP_FIRST = (
    ("orders", "ck_orders_from_quote"),
    ("trade_docs", "ck_doc_has_parent"),
    ("orders", "ck_orders_has_customer"),
    ("trade_docs", "ck_docs_has_customer"),
)


def upgrade() -> None:
    for table, name in DROP_FIRST:
        op.execute(sa.text(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}"))

    # 只要求"必须归属业务客户"（手动新建/导入也要选客户，但不强制有报价/订单）
    op.execute(sa.text(
        "ALTER TABLE orders ADD CONSTRAINT ck_orders_has_customer"
        " CHECK (customer_id IS NOT NULL) NOT VALID"))
    op.execute(sa.text(
        "ALTER TABLE trade_docs ADD CONSTRAINT ck_docs_has_customer"
        " CHECK (customer_id IS NOT NULL) NOT VALID"))


def downgrade() -> None:
    # 回退到 010 的约束集合（不含过严项；过严项已证明与业务要求冲突，不回退）
    for table, name in (
        ("orders", "ck_orders_has_customer"),
        ("trade_docs", "ck_docs_has_customer"),
    ):
        op.execute(sa.text(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}"))
