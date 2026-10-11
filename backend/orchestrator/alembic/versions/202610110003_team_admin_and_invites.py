"""团队管理员 + 邀请机制

Revision ID: 202610110003
Revises: 202610110002
Create Date: 2026-10-11

业务规则（2026-10-11 确认）
--------------------------
- **团队由第一个成员创建**，创建者即**团队管理员**，可管理本团队（改名/邀请/移除成员）。
  为此 `teams` 增加 `created_by`。
- **加入现有团队必须凭邀请码** —— 不设"随便挑个团队就加入"，否则 A 公司的人可以
  自由进入 B 公司团队、看到 B 的数据。为此新增 `team_invites`。
- 邀请两条路：**邮箱点名**（对方已注册直接入队；未注册生成邀请码）+
  **通用邀请码**（不指定邮箱，谁拿到谁用）。

存量数据
--------
`teams.created_by` 回填为**该团队最早加入的成员**（最早 = users.id 最小）。
这样迁移前就已存在的团队立刻有管理员，不会出现"没人能管理它"的空档。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110003"
down_revision: Union[str, None] = "202610110002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. 团队管理员（团队创建者）────────────────────────────────────────
    op.add_column("teams", sa.Column("created_by", sa.BigInteger(), nullable=True))
    op.create_foreign_key("fk_teams_created_by", "teams", "users",
                          ["created_by"], ["id"], ondelete="SET NULL")
    # 存量团队：把最早加入的成员认作创建者/管理员
    op.execute(
        "UPDATE teams SET created_by = ("
        "  SELECT MIN(u.id) FROM users u WHERE u.team_id = teams.id"
        ") WHERE created_by IS NULL"
    )

    # ── 2. 邀请 ───────────────────────────────────────────────────────────
    op.create_table(
        "team_invites",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("team_id", sa.BigInteger(), nullable=False),
        # 邮箱点名邀请时记录；通用邀请码时为 NULL
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column("token", sa.Text(), nullable=False),
        sa.Column("invited_by", sa.BigInteger(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_by", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["team_id"], ["teams.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["invited_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["accepted_by"], ["users.id"], ondelete="SET NULL"),
    )
    # 邀请码全局唯一：凭它入队，撞码等于进错团队
    op.create_index("uq_team_invites_token", "team_invites", ["token"], unique=True)
    op.create_index("idx_team_invites_team", "team_invites", ["team_id", "status"])
    # 邮箱点名去重/查询（团队内同一邮箱只留一条 pending 的判定在应用层）
    op.create_index("idx_team_invites_email", "team_invites", ["email"])


def downgrade() -> None:
    op.drop_index("idx_team_invites_email", table_name="team_invites")
    op.drop_index("idx_team_invites_team", table_name="team_invites")
    op.drop_index("uq_team_invites_token", table_name="team_invites")
    op.drop_table("team_invites")

    op.drop_constraint("fk_teams_created_by", "teams", type_="foreignkey")
    op.drop_column("teams", "created_by")
