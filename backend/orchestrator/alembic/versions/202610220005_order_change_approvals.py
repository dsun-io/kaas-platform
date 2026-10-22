"""已确认订单明细变更审批 + 站内通知 + 指定审批人（设计 §6.1 / §6.2）

Revision ID: 202610220005
Revises: 202610220004
Create Date: 2026-10-22

业务背景
--------
用户 2026-10-22 拍板（D-8 / D-10~D-14）：
- 已确认（`status >= confirmed`）订单的货物明细**允许改，但要留痕 + 管理员审批**；
- 审批需要**通知与对应模块**，否则"提交了申请没人知道"；
- 团队可指定审批人，**指定审批人优先，否则团队管理员**；
- 管理员自己改也走同一流程（申请人=批准人也留痕），不提供直改旁路。

范围铁律：只做**审批相关**通知，不建设通用事件总线
（`domain_events` 按 G-15 暂缓，不得借道复活）。

三张表
------
| 表 | 作用 |
|---|---|
| `order_item_change_requests` | 变更申请：新旧明细对比 + 原因 + 申请人 + 决定 |
| `notifications` | 站内通知（审批请求 / 批准 / 拒绝） |
| `team_approvers` | 指定审批人名单；**空 = 团队管理员审批** |

为什么 `team_approvers` 用复合主键而不是自增 id：一个 (团队, 人) 只应存在一行，
自增 id + 唯一索引能表达同样的事，但复合主键让"重复添加"在 DB 层直接不可能，
且 PUT 语义（整表替换）用主键删除更直观。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "202610220005"
down_revision: Union[str, None] = "202610220004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. 指定审批人（D-11 / D-14）──────────────────────────────────────────
    op.create_table(
        "team_approvers",
        sa.Column("team_id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        # 谁把这个人设为审批人的（管理员维护，审计用）
        sa.Column("created_by", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "user_id"),
        # 团队没了 → 名单跟着没（没有悬空的"某团队审批人"）
        sa.ForeignKeyConstraint(["team_id"], ["teams.id"], ondelete="CASCADE"),
        # 人被删 → 只摘这一条，不牵连团队其他人
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
    )
    op.create_index("idx_team_approvers_user", "team_approvers", ["user_id"])

    # ── 2. 订单货物明细变更申请（D-8）────────────────────────────────────────
    op.create_table(
        "order_item_change_requests",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        # 订单被硬删 → 申请跟着没（没有"给不存在的订单改明细"的申请）
        sa.Column("order_id", sa.BigInteger(), nullable=False),
        sa.Column("requested_by", sa.BigInteger(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        # items = **新**明细（整批替换语义，与 PATCH /orders/{id} 的 items 同构）；
        # snapshot = 提交时的**旧**明细快照（审批页做新旧对比，不依赖订单当前值）
        sa.Column("items", JSONB(), nullable=False,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column("snapshot", JSONB(), nullable=True),
        # pending | approved | rejected（流转规则见内核 ws_approvals.py）
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("decided_by", sa.BigInteger(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        # 拒绝**必填**理由（前端拦截 + 后端校验，双保险）
        sa.Column("decision_reason", sa.Text(), nullable=True),
        # 冗余团队：审批路由与「待我审批」列表按团队筛，避免每次 JOIN orders
        sa.Column("team_id", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "status IN ('pending','approved','rejected')",
            name="ck_order_item_change_status",
        ),
        # 拒绝必须留理由：否则被拒方只看到"被拒了"，不知道要改什么
        sa.CheckConstraint(
            "status <> 'rejected' OR decision_reason IS NOT NULL",
            name="ck_order_item_change_reject_reason",
        ),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requested_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["decided_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["team_id"], ["teams.id"], ondelete="SET NULL"),
    )
    op.create_index("idx_oicr_order", "order_item_change_requests",
                    ["tenant_id", "order_id", "created_at"])
    # 「待我审批」按团队 + pending 扫，必须有索引
    op.create_index("idx_oicr_team_status", "order_item_change_requests",
                    ["tenant_id", "team_id", "status"])

    # ── 3. 站内通知（D-10）──────────────────────────────────────────────────
    op.create_table(
        "notifications",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("team_id", sa.BigInteger(), nullable=True),
        # 收件人：审批请求按路由**逐人**落行（不是一条群发），
        # 这样"已读"才是 per-user 的，A 读了不影响 B 的未读角标。
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        # approval_requested | approval_approved | approval_rejected
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        # 深链（如 /approvals?focus={rid}）
        sa.Column("link", sa.Text(), nullable=True),
        sa.Column("ref_type", sa.Text(), nullable=True),
        sa.Column("ref_id", sa.BigInteger(), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "type IN ('approval_requested','approval_approved','approval_rejected')",
            name="ck_notifications_type",
        ),
        sa.ForeignKeyConstraint(["team_id"], ["teams.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    # 铃铛未读数 + 列表：都是 (user_id, read_at IS NULL, created_at DESC)
    op.create_index("idx_notifications_user_unread", "notifications",
                    ["user_id", "read_at", "created_at"])


def downgrade() -> None:
    op.drop_index("idx_notifications_user_unread", table_name="notifications")
    op.drop_table("notifications")
    op.drop_index("idx_oicr_team_status", table_name="order_item_change_requests")
    op.drop_index("idx_oicr_order", table_name="order_item_change_requests")
    op.drop_table("order_item_change_requests")
    op.drop_index("idx_team_approvers_user", table_name="team_approvers")
    op.drop_table("team_approvers")
