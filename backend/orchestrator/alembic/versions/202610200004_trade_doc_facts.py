"""A7 单证加固：事实层 `trade_doc_facts`（HARDENING_PLAN §A / §5）

Revision ID: 202610200004
Revises: 202610200003
Create Date: 2026-10-21

背景（`docs/UNCERTAIN.md` #17 口径已拍板）：
单证 payload 里的一坨字段升级为**可追溯、有信任级、有不可改写属性**的事实，
用于跨单证一致性引擎与「推断值不得进 issued」闸门：

- `trust`：confirmed / unverified / inferred（issued 只允许 confirmed）；
- `immutable`：基线事实派生单只能原值引用（改值 → `FACT_IMMUTABLE`）；
- `text_zh`/`text_en`：双语成对；`source` + `evidence_ref`：值从哪来、可回溯；
- `value_text` 存规范化字符串，`value_num` 存金额（供容差比对）。

结构幂等（create_table 仅新增）；回滚 = drop table。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610200004"
down_revision: Union[str, None] = "202610200003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "trade_doc_facts",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        # 事实挂在具体单证上；单证删除时事实一并回收
        sa.Column(
            "trade_doc_id", sa.BigInteger(),
            sa.ForeignKey("trade_docs.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("doc_type", sa.Text(), nullable=False),
        sa.Column("doc_no", sa.Text(), nullable=True),
        # 规范化事实键：total_amount / unit_price[1] / incoterm / payment_deposit_ratio ...
        sa.Column("fact_key", sa.Text(), nullable=False),
        sa.Column("value_text", sa.Text(), nullable=True),
        sa.Column("value_num", sa.Numeric(20, 6), nullable=True),
        sa.Column("currency", sa.Text(), nullable=True),
        sa.Column("text_zh", sa.Text(), nullable=True),
        sa.Column("text_en", sa.Text(), nullable=True),
        # pi | upstream_doc | manual | ai_suggested | inferred
        sa.Column("source", sa.Text(), nullable=False, server_default="manual"),
        # confirmed | unverified | inferred
        sa.Column("trust", sa.Text(), nullable=False, server_default="unverified"),
        sa.Column("immutable", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("confirmed_by", sa.Text(), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("evidence_ref", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "uq_trade_doc_fact",
        "trade_doc_facts",
        ["tenant_id", "trade_doc_id", "fact_key"],
        unique=True,
    )
    op.create_index(
        "idx_trade_doc_facts_doc", "trade_doc_facts", ["tenant_id", "trade_doc_id"]
    )
    op.create_index(
        "idx_trade_doc_facts_key", "trade_doc_facts", ["tenant_id", "fact_key"]
    )


def downgrade() -> None:
    op.drop_index("idx_trade_doc_facts_key", table_name="trade_doc_facts")
    op.drop_index("idx_trade_doc_facts_doc", table_name="trade_doc_facts")
    op.drop_index("uq_trade_doc_fact", table_name="trade_doc_facts")
    op.drop_table("trade_doc_facts")
