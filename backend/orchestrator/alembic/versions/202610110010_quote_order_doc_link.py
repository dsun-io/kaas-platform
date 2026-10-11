"""报价 → 订单 / 报价 → 报价单：补上"包含关系"所缺的两列

Revision ID: 202610110010
Revises: 202610110009
Create Date: 2026-10-11

为什么需要
----------
业务要求按**包含关系**展示一个业务客户的历史数据：

```
业务客户
├── 报价 1（已接受）
│   ├── 单证：报价单 Quotation
│   └── 订单 A（由该报价生成）
│       └── 单证：PI / CI / PL / BL
└── 报价 2（已发出）
    └── 单证：报价单 Quotation
```

但现有表结构表达不了两条关键关系：

| 关系 | 迁移前 | 本迁移 |
|---|---|---|
| 报价 → 由它生成的订单 | `orders` **没有 `quote_id`** | ✅ 新增 `orders.quote_id` + FK |
| 报价 → 报价单 | `trade_docs` **只有 `order_id`** | ✅ 新增 `trade_docs.quote_id` + FK |

（客户 → 报价/订单、订单 → 单证 的外键已由 `009` 建立）

归属规则（**二选一，不并存**）
------------------------------
- `trade_docs.doc_type = 'quotation'` → 挂 `quote_id`（报价单属于报价）
- 其他类型（pi/ci/pl/bl…）→ 挂 `order_id`（属于订单）

回填
----
`orders.quote_id` 没有历史来源，无法推断 → 保持 NULL（前端按"未关联"折叠区展示，
**不丢数据**）；`trade_docs` 同理。`doc_no` 与 `quote_no` 相同的历史报价单会被回填。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110010"
down_revision: Union[str, None] = "202610110009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 报价 → 订单 ──
    op.add_column("orders", sa.Column("quote_id", sa.BigInteger(), nullable=True))
    op.create_foreign_key("fk_orders_quote_id", "orders", "quote_orders",
                          ["quote_id"], ["id"], ondelete="SET NULL")
    op.create_index("idx_orders_quote", "orders", ["quote_id"])

    # ── 报价 → 报价单 ──
    op.add_column("trade_docs", sa.Column("quote_id", sa.BigInteger(), nullable=True))
    op.create_foreign_key("fk_trade_docs_quote_id", "trade_docs", "quote_orders",
                          ["quote_id"], ["id"], ondelete="SET NULL")
    op.create_index("idx_trade_docs_quote", "trade_docs", ["quote_id"])

    # ── 按客户聚合（客户详情页的"往来记录"）要走的索引 ──
    op.create_index("idx_quote_orders_customer_created",
                    "quote_orders", ["customer_id", "created_at"])
    op.create_index("idx_orders_customer_created",
                    "orders", ["customer_id", "created_at"])
    op.create_index("idx_trade_docs_customer_created",
                    "trade_docs", ["customer_id", "created_at"])

    # ── 尽力回填：历史报价单（doc_no 与 quote_no 相同）挂回报价 ──
    op.execute(sa.text(
        "UPDATE trade_docs d SET quote_id = q.id"
        " FROM quote_orders q"
        " WHERE d.quote_id IS NULL"
        "   AND d.doc_type = 'quotation'"
        "   AND d.tenant_id = q.tenant_id"
        "   AND d.doc_no = q.quote_no"
    ))

    # ── P1：让"必须归属"成为约束 ──
    # `NOT VALID` = 历史行豁免、**新行必须满足**：新数据不可能再出现"无主的单据"，
    # 又不会因历史脏数据让迁移失败。历史回填收敛后可再 VALIDATE。
    #
    # 注意：**刻意不强制 `orders.quote_id` / `trade_docs.quote_id|order_id` 非空** ——
    # 业务要支持**手动新建与导入已有数据**（历史订单可能根本没有报价、历史单证可能
    # 两者都没有，只归属客户）。包含关系由正常业务流程产生，而不是靠约束把导入挡在门外。
    #
    # 1) 单据必须挂业务客户（手动新建/导入时也要选客户）
    op.execute(sa.text(
        "ALTER TABLE orders ADD CONSTRAINT ck_orders_has_customer"
        " CHECK (customer_id IS NOT NULL) NOT VALID"))
    op.execute(sa.text(
        "ALTER TABLE trade_docs ADD CONSTRAINT ck_docs_has_customer"
        " CHECK (customer_id IS NOT NULL) NOT VALID"))
    # 2) 归属二选一：同一张单证不能同时挂报价和订单（否则树里会重复出现）
    op.execute(sa.text(
        "ALTER TABLE trade_docs ADD CONSTRAINT ck_doc_single_parent"
        " CHECK (quote_id IS NULL OR order_id IS NULL) NOT VALID"))


def downgrade() -> None:
    for name, table in (
        ("ck_doc_single_parent", "trade_docs"),
        ("ck_docs_has_customer", "trade_docs"),
        ("ck_orders_has_customer", "orders"),
    ):
        op.drop_constraint(name, table, type_="check")
    for idx, table in (
        ("idx_trade_docs_customer_created", "trade_docs"),
        ("idx_orders_customer_created", "orders"),
        ("idx_quote_orders_customer_created", "quote_orders"),
        ("idx_trade_docs_quote", "trade_docs"),
        ("idx_orders_quote", "orders"),
    ):
        op.drop_index(idx, table_name=table)
    op.drop_constraint("fk_trade_docs_quote_id", "trade_docs", type_="foreignkey")
    op.drop_column("trade_docs", "quote_id")
    op.drop_constraint("fk_orders_quote_id", "orders", type_="foreignkey")
    op.drop_column("orders", "quote_id")
