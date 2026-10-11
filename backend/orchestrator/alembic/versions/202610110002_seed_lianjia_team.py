"""建「安平县联佳丝网制品有限公司」团队，并把联佳账号归入该团队

Revision ID: 202610110002
Revises: 202610110001
Create Date: 2026-10-11

为什么要写成迁移而不是手工 SQL
-----------------------------
三层组织上线后，团队必须**在生产也存在**，否则成员创建的记录会因为没有团队而
退化成"仅本人可见"（`team_id IS NULL` 走原有判定）。放在迁移里就随部署自动生效，
不需要任何手工步骤。

幂等
----
- 团队用 `ON CONFLICT DO NOTHING`（`uq_teams_tenant_name` 唯一约束兜底）；
- 成员归属只认**已存在**的账号（按邮箱 `lianjia@kaas.local`，即联佳那个账号），
  账号不存在时静默跳过 —— 换环境（测试/生产账号不同）不会让迁移失败。

刻意不做的事
------------
**不给 `customers` 表里那几行补 team_id**。那几行是**账号主体**（注册流程
`app/api/auth.py` 会建 Customer + UserCustomer 绑定），不是业务上的"客户"。
它们 `team_id` 保持 NULL，可见性与上线前完全一致（零回归）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110002"
down_revision: Union[str, None] = "202610110001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TENANT_ID = "default"
TEAM_NAME = "安平县联佳丝网制品有限公司"
# 联佳账号（其数据归属联佳团队）。按邮箱认账号，账号不存在则跳过。
LIANJIA_EMAILS = ("lianjia@kaas.local",)


def upgrade() -> None:
    op.execute(sa.text(
        "INSERT INTO teams (tenant_id, name, created_at, updated_at)"
        " VALUES (:tenant, :name, now(), now())"
        " ON CONFLICT (tenant_id, name) DO NOTHING"
    ).bindparams(tenant=TENANT_ID, name=TEAM_NAME))

    op.execute(sa.text(
        "UPDATE users SET team_id = ("
        "  SELECT id FROM teams WHERE tenant_id = :tenant AND name = :name"
        ") WHERE email = ANY(:emails) AND team_id IS NULL"
    ).bindparams(tenant=TENANT_ID, name=TEAM_NAME, emails=list(LIANJIA_EMAILS)))


def downgrade() -> None:
    # 只解除归属，不删账号；团队本身若已挂业务数据也不强删（避免破坏 team_id 外键）
    op.execute(sa.text(
        "UPDATE users SET team_id = NULL WHERE team_id = ("
        "  SELECT id FROM teams WHERE tenant_id = :tenant AND name = :name"
        ")"
    ).bindparams(tenant=TENANT_ID, name=TEAM_NAME))
    op.execute(sa.text(
        "DELETE FROM teams WHERE tenant_id = :tenant AND name = :name"
    ).bindparams(tenant=TENANT_ID, name=TEAM_NAME))
