"""P1 单证加固：收款登记 + 单证清单（UNCERTAIN #17 ③④ 同批迁移）

Revision ID: 202610170003
Revises: 202610170002
Create Date: 2026-10-17

背景（TRADE_DOC_HARDENING_PLAN §C/§E，2026-10-12 Tim 单复盘 14 条抽象）：

1. `trade_doc_receipts`（收款登记，§E）：
   - 每笔收款 vs 单证/账期金额的差额（`diff`）与归因（`diff_reason`）；
   - 容差裁决（UNCERTAIN #17 ③）：每币种 `max(5 美分等值, 0.1%)` ——
     差额 ≤ 容差自动核销（`fx_rounding`），否则挂 `short_paid` 告警。

2. `trade_doc_doc_set_items`（单证清单，§C + UNCERTAIN #17 ④）：
   - 「这一次交易该出哪些单证」显式清单，`not_by_us`（对方出单）走
     **回执登记**：`pending → received`（对方提供后登记）/ `waived(reason)`；
   - 清单外的单证不允许被引用（见 P0 引用完整性）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202610170003"
down_revision: Union[str, None] = "202610170002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "trade_doc_receipts",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("trade_doc_id", sa.BigInteger(), nullable=False),
        sa.Column("schedule_type", sa.Text(), nullable=True),
        sa.Column("schedule_amount", sa.Numeric(20, 6), nullable=True),
        sa.Column("received_amount", sa.Numeric(20, 6), nullable=False),
        sa.Column("currency", sa.Text(), nullable=False, server_default="USD"),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("bank_ref", sa.Text(), nullable=True),
        sa.Column("diff", sa.Numeric(20, 6), nullable=True),
        sa.Column("diff_reason", sa.Text(), nullable=True),
        sa.Column("fx_rate_used", sa.Numeric(20, 8), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="manual"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "idx_trade_doc_receipts_doc", "trade_doc_receipts", ["tenant_id", "trade_doc_id"]
    )

    op.create_table(
        "trade_doc_doc_set_items",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        # 清单挂在根单证（order/contract）上 —— UNCERTAIN #17 ①：以 order 为事实域
        sa.Column("trade_doc_id", sa.BigInteger(), nullable=False),
        sa.Column("doc_type", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False, server_default="required"),
        sa.Column("issuer", sa.Text(), nullable=False, server_default="ours"),
        sa.Column("trigger_expr", sa.Text(), nullable=True),
        sa.Column("evidence_required", sa.Boolean(), nullable=False, server_default="false"),
        # not_by_us 回执登记（UNCERTAIN #17 ④）：pending → received / waived
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("waived_reason", sa.Text(), nullable=True),
        sa.Column("received_doc_id", sa.BigInteger(), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "uq_trade_doc_doc_set_item",
        "trade_doc_doc_set_items",
        ["tenant_id", "trade_doc_id", "doc_type"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_trade_doc_doc_set_item", table_name="trade_doc_doc_set_items")
    op.drop_table("trade_doc_doc_set_items")
    op.drop_index("idx_trade_doc_receipts_doc", table_name="trade_doc_receipts")
    op.drop_table("trade_doc_receipts")
