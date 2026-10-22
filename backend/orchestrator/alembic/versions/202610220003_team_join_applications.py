"""团队加入申请（注册时团队已存在 → 直接申请，管理员审核后入团）

Revision ID: 202610220003
Revises: 202610220002
Create Date: 2026-10-22

业务规则（2026-10-22 用户需求）
------------------------------
- 新用户注册填写企业/团队时，**团队已存在**的情况下：除邀请码外，可**直接发起
  进入团队申请**（带可选留言 ≤200 字）；团队管理员审核通过才入团。
- 申请状态机（真源 = kaas_common/workstation/teams.py:can_transition_application）：
  pending ──approve──► approved（终态）
  pending ──reject───► rejected（终态，可再次申请）
  pending ──cancel───► canceled（终态，申请人撤回，可再次申请）
  非 pending 的任何审核操作 → 409 APPLICATION_ALREADY_REVIEWED。
- **一个用户同时只允许一条 pending 申请**：部分唯一索引
  `uq_join_applications_user_pending` 兜底并发（应用层同事务内也校验）。
- 审核通过 = `users.team_id` 落值；工位订阅是**团队级**，通过即天然获得团队
  已开通工位，无需逐成员授权。
- 邀请码一次一码的既有语义不变（本模块不改 team_invites）。

存量数据
--------
纯新增表，无存量数据；`tenant_id` 恒为 `default`（生产单租户，团队才是隔离边界）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610220003"
down_revision: Union[str, None] = "202610220002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "team_join_applications",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("team_id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        # 申请人信息快照：管理员审核视图直接可读，不依赖 JOIN users
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        # pending|approved|rejected|canceled（流转规则见模块 docstring）
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("reviewed_by", sa.BigInteger(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reject_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "status IN ('pending','approved','rejected','canceled')",
            name="ck_join_applications_status",
        ),
        sa.ForeignKeyConstraint(["team_id"], ["teams.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reviewed_by"], ["users.id"], ondelete="SET NULL"),
    )
    # 同一用户同时只允许一条待审申请（Postgres 部分唯一索引，兜底并发双开）
    op.create_index(
        "uq_join_applications_user_pending", "team_join_applications", ["user_id"],
        unique=True, postgresql_where=sa.text("status = 'pending'"),
    )
    op.create_index("idx_join_applications_team_status",
                    "team_join_applications", ["team_id", "status"])


def downgrade() -> None:
    op.drop_index("idx_join_applications_team_status", table_name="team_join_applications")
    op.drop_index("uq_join_applications_user_pending", table_name="team_join_applications")
    op.drop_table("team_join_applications")
