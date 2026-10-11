"""三层组织可见性：teams 表 + users.team_id + 四域业务表 team_id

Revision ID: 202610110001
Revises: 202610100007
Create Date: 2026-10-11

背景
----
租户内分三层：**管理员 / 团队 / 成员**。成员创建的客户（及订单/报价/单证/出运/询盘）
应当**本团队可见、其他团队不可见**。在此之前系统只有两级语义
（`owner_scope`：private=仅自己 / tenant=全租户），没有"团队"这一层。

本次新增
--------
1. `teams(tenant_id, name)`：租户内的团队（管理员建团队、分配成员）。
2. `users.team_id`：一个成员属于一个团队（NULL = 未分组）。
3. 四域 8 张业务表的 `team_id`：写入时取创建者的团队。

为什么行上直接记 team_id（而不是靠 owner_id 反查属主团队）
---------------------------------------------------------
- 判定无需 JOIN（orchestrator 与 Worker 的 SQL 都简单一档）；
- 成员换团队/离职后数据仍留在原团队，不跟着人走；
- 历史数据可以**显式指定**归属团队，不必编造一个"属主"。

零回归保证
----------
所有 `team_id` 均可空，且**为空的行走原有判定**（管理员 / owner_scope=tenant /
owner_id=我）。因此本迁移上线时不会改变任何现有数据的可见性 ——
可见性变化只发生在**显式分配了团队的行**上。

回滚
----
downgrade 先删业务列、再删 users.team_id，最后删 teams 表。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110001"
down_revision: Union[str, None] = "202610100007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 四域（客户/订单/报价/单证）内带 owner_scope 的表 —— 团队隔离的作用面。
# 未列入者（lead_candidates / research_products 属线索池/市场调研域）本次不动。
SCOPED_TABLES = (
    "cust_inquiries",
    "customers",
    "orders",
    "payment_schedules",
    "quote_orders",
    "receivables",
    "shipments",
    "trade_docs",
)


def upgrade() -> None:
    # ── 1. 团队 ────────────────────────────────────────────────────────────
    op.create_table(
        "teams",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    # 同一租户内团队名唯一（管理员按名字认团队，重名会让人选错）
    op.create_index("uq_teams_tenant_name", "teams", ["tenant_id", "name"], unique=True)

    # ── 2. 用户归属团队 ───────────────────────────────────────────────────
    op.add_column("users", sa.Column("team_id", sa.BigInteger(), nullable=True))
    op.create_foreign_key("fk_users_team", "users", "teams",
                          ["team_id"], ["id"], ondelete="SET NULL")
    op.create_index("idx_users_team", "users", ["team_id"])

    # ── 3. 业务行归属团队（可空；为空即保持原有可见性）────────────────────
    for table in SCOPED_TABLES:
        op.add_column(table, sa.Column("team_id", sa.BigInteger(), nullable=True))
        op.create_foreign_key(f"fk_{table}_team", table, "teams",
                              ["team_id"], ["id"], ondelete="SET NULL")
        op.create_index(f"idx_{table}_team", table, ["team_id"])


def downgrade() -> None:
    for table in reversed(SCOPED_TABLES):
        op.drop_index(f"idx_{table}_team", table_name=table)
        op.drop_constraint(f"fk_{table}_team", table, type_="foreignkey")
        op.drop_column(table, "team_id")

    op.drop_index("idx_users_team", table_name="users")
    op.drop_constraint("fk_users_team", "users", type_="foreignkey")
    op.drop_column("users", "team_id")

    op.drop_index("uq_teams_tenant_name", table_name="teams")
    op.drop_table("teams")
