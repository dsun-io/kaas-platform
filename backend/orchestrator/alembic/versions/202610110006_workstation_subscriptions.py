"""工位订阅：团队订阅 + 个人订阅

Revision ID: 202610110006
Revises: 202610110005
Create Date: 2026-10-11

授权模型（业务确认）
--------------------
业务逻辑**不以租户做鉴权边界**。真正的边界是「这个账号/团队开通了哪些**工位**」：

- **团队为主**：团队开通 = 全员可用（`team_subscriptions`）
- **个人可额外开通**：某人单开一个工位（`user_subscriptions`）
- 平台管理员不受限

判定与执行见 `kaas_common/workstation/subscriptions.py`（两端共用）。
未开通的工位 API 返回 404；另有「我的工位」接口给前端隐藏入口/显示开通引导。

存量访问保住
------------
原先的 `tenant_subscriptions` 里 `default` 与 `lianjia` 都有 `full_chain`。
本迁移给**已存在的每个团队**补一条 `full_chain`，避免上线瞬间"所有人都被锁在门外"。
**新建的团队不给**（要走开通流程 —— 先手动开通，支付后接）。

`tenant_subscriptions` 保留但不再参与判定（历史表，留档）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110006"
down_revision: Union[str, None] = "202610110005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

FULL_CHAIN = "full_chain"


def _subscription_table(name: str, subject_col: str, subject_table: str) -> None:
    op.create_table(
        name,
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column(subject_col, sa.BigInteger(), nullable=False),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        # 开通来源：manual（后台手动）/ payment（付费）/ system_migration —— 为将来接支付留位
        sa.Column("source", sa.Text(), nullable=False, server_default="manual"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint([subject_col], [f"{subject_table}.id"], ondelete="CASCADE"),
    )
    op.create_index(f"uq_{name}_code", name, [subject_col, "code"], unique=True)
    op.create_index(f"idx_{name}_active", name, [subject_col, "active"])


def upgrade() -> None:
    _subscription_table("team_subscriptions", "team_id", "teams")
    _subscription_table("user_subscriptions", "user_id", "users")

    # 保住存量访问：给现有团队补 full_chain（新建团队不补，走开通流程）
    op.execute(
        f"INSERT INTO team_subscriptions (team_id, code, source)"
        f" SELECT t.id, '{FULL_CHAIN}', 'system_migration' FROM teams t"
        f" WHERE NOT EXISTS ("
        f"   SELECT 1 FROM team_subscriptions s WHERE s.team_id = t.id"
        f" )"
    )


def downgrade() -> None:
    op.drop_index("idx_user_subscriptions_active", table_name="user_subscriptions")
    op.drop_index("uq_user_subscriptions_code", table_name="user_subscriptions")
    op.drop_table("user_subscriptions")
    op.drop_index("idx_team_subscriptions_active", table_name="team_subscriptions")
    op.drop_index("uq_team_subscriptions_code", table_name="team_subscriptions")
    op.drop_table("team_subscriptions")
