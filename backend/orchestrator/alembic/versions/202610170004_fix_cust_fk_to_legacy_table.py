"""修复 schema 漂移：cust_contacts/cust_inquiries/cust_stage_log 的外键改指主表 `customers`

Revision ID: 202610170004
Revises: 202610170003
Create Date: 2026-10-17

**缺陷（2026-10-17 真库 CRUD 验证时发现）**：
ORM 模型（`workstation_models.py`）三张表的 `customer_id` 都声明
`ForeignKey('customers.id', ondelete='CASCADE')`（主表），但**真库约束指向遗留表
`cust_customers`**（空表，merge_customers 迁移后遗留）⇒ 真库上「添加询盘 /
添加联系人 / 阶段流转」全部 `ForeignKeyViolation`（customer_id 在 cust_customers
里不存在）。单元测试是 mock 不连库、e2e 走 MSW，所以此前从未暴露。

修复：三个约束改指 `customers(id) ON DELETE CASCADE`（与 ORM 语义一致）。
遗留表 `cust_customers` 本身是否删除另议（E3，删表前还要清 wechat_* 等遗留）。
"""
from typing import Sequence, Union

from alembic import op

revision: str = "202610170004"
down_revision: Union[str, None] = "202610170003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("cust_contacts", "cust_inquiries", "cust_stage_log")


def upgrade() -> None:
    for t in TABLES:
        op.drop_constraint(f"{t}_customer_id_fkey", t, type_="foreignkey")
        op.create_foreign_key(
            f"{t}_customer_id_fkey",
            t,
            "customers",
            ["customer_id"],
            ["id"],
            ondelete="CASCADE",
        )


def downgrade() -> None:
    for t in TABLES:
        op.drop_constraint(f"{t}_customer_id_fkey", t, type_="foreignkey")
        op.create_foreign_key(
            f"{t}_customer_id_fkey",
            t,
            "cust_customers",
            ["customer_id"],
            ["id"],
            ondelete="CASCADE",
        )
