"""quote_orders / orders 补数据可见范围列（§10.3）

Revision ID: 202609260002
Revises: 202609260001

背景：报价工位与订单工位的 API（api/quotes.py、api/orders.py）都会调用通用的
`scope_filter()` 做「自己账号数据 + owner 开放的企业数据」过滤，写数据时也传
`owner_id` / `owner_scope`。但这两张表在建表迁移里漏了这两列，而同类的
cust_inquiries / shipments / payment_schedules / receivables 都有 ——
结果就是打开这两个工位直接 500：
    TypeError: 'owner_id' is an invalid keyword argument for QuoteOrder

可见范围是数据隔离的基础（决定「谁能看到谁的数据」），不能靠去掉过滤绕过去，
所以这里补列，而不是改代码。

安全性：两列均可空 / 有默认值，不改动、不删除任何现有数据。

为什么用 `IF NOT EXISTS` 而不是 `op.add_column`：
本仓库存在另一条迁移谱系（游离提交 25cd8f1 的 6cdbf90cb548 → 2026060800xx），
线上/开发库到底属于哪条谱系、是否已经有这两列，在连上真实库核实前无法确定。
如果目标库已有同名列，`op.add_column` 会让整个 upgrade 硬失败，
而且失败点卡在中间会留下半成品状态。带 IF NOT EXISTS 保证在两种库上都能安全跑完。
（注：代价是它不会报出“列已存在”的信号；核实真实库后应转为显式判断。）
"""
from typing import Sequence, Union

from alembic import op

revision: str = "202609260002"
down_revision: Union[str, None] = "202609260001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ("quote_orders", "orders")


def upgrade() -> None:
    for table in _TABLES:
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS owner_id TEXT")
        # NOT NULL + DEFAULT：与 cust_inquiries 等表的写法保持一致
        op.execute(
            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS "
            f"owner_scope TEXT NOT NULL DEFAULT 'private'"
        )
        # 可见范围过滤按 (tenant, owner_scope) 查，建索引避免全表扫
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{table}_owner ON {table} (tenant_id, owner_scope)"
        )


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.execute(f"DROP INDEX IF EXISTS idx_{table}_owner")
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS owner_scope")
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS owner_id")
