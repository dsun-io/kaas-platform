"""询盘阶段落库（TODO F4）：`cust_inquiries.stage` + `inquiry_stage_log`

背景
----
`cust_inquiries.status` 只有报价三态（unquoted/quoted/closed），而 UI 的
「关闭/询盘/报价/订单/发货/完结」是**前端按订单/单证状态推导**，不落库 ——
报表、按阶段筛选、历史变更都拿不到。用户 2026-10-20 拍板：**落库 + 事件驱动**
（前端展示推导保留为兜底）。本迁移加：

1. `cust_inquiries.stage`（阶段，默认 `inquiry`）+ `stage_updated_at`；
   并按 status 回填历史行（closed→closed、quoted→quotation、其余→inquiry）；
2. `inquiry_stage_log`：每次**真实**阶段变更一条（谁/哪个事件/从哪到哪）。

阶段序与终态见 `backend/worker/src/inquiry_stage.py`（唯一真源，本迁移只落结构）。

Revision ID: 202610200003
Revises: 202610200002
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "202610200003"
down_revision: Union[str, None] = "202610200002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "cust_inquiries",
        sa.Column("stage", sa.Text(), nullable=False, server_default="inquiry"),
    )
    op.add_column(
        "cust_inquiries",
        sa.Column("stage_updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    # 历史回填（幂等：只补 stage 仍为默认值的行，重跑不会覆盖后续事件推进的结果）
    op.execute(
        "UPDATE cust_inquiries SET stage = CASE"
        "  WHEN status = 'closed' THEN 'closed'"
        "  WHEN status = 'quoted' THEN 'quotation'"
        "  ELSE 'inquiry' END"
        " WHERE stage = 'inquiry' AND status IN ('closed', 'quoted')"
    )
    op.create_table(
        "inquiry_stage_log",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column(
            "inquiry_id", sa.BigInteger(),
            sa.ForeignKey("cust_inquiries.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("from_stage", sa.Text(), nullable=False),
        sa.Column("to_stage", sa.Text(), nullable=False),
        # quote_created | order_created | order_completed | shipment_created |
        # inquiry_closed
        sa.Column("source_event", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index(
        "idx_inquiry_stage_log_inquiry",
        "inquiry_stage_log",
        ["tenant_id", "inquiry_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_inquiry_stage_log_inquiry", table_name="inquiry_stage_log")
    op.drop_table("inquiry_stage_log")
    op.drop_column("cust_inquiries", "stage_updated_at")
    op.drop_column("cust_inquiries", "stage")
