"""trade_doc_upstream_refs

Revision ID: 20260921_trade_doc_upstream_refs
Revises: 20260919_workstation_links
Create Date: 2026-09-21

为外贸单证工位补全周期上游口子：单证可从询盘 / 报价单 / 订单任一上游实体生成
（见 docs/WORKSTATION_DESIGN.md §6.3「单证类型 × 生成阶段」）。
trade_doc_order_refs 已存在，这里补 trade_doc_quote_refs / trade_doc_inquiry_refs。

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '20260921_trade_doc_upstream_refs'
down_revision: Union[str, None] = '20260919_customers_market_subs'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 单证 ← 报价单（报价/订单阶段出 Quotation、PI、销售合同） ──────────────
    op.create_table(
        'trade_doc_quote_refs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('trade_doc_id', sa.BigInteger(), nullable=False),
        sa.Column('quote_order_id', sa.BigInteger(), nullable=False),
        sa.Column('ref_type', sa.Text(), nullable=False, server_default='generated_from'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'trade_doc_id', 'ref_type', 'quote_order_id', name='uq_trade_doc_quote_refs'),
    )

    # ── 单证 ← 询盘（询盘/报价阶段出 Quotation、PI） ──────────────────────────
    op.create_table(
        'trade_doc_inquiry_refs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('trade_doc_id', sa.BigInteger(), nullable=False),
        sa.Column('inquiry_id', sa.BigInteger(), nullable=False),
        sa.Column('ref_type', sa.Text(), nullable=False, server_default='generated_from'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'trade_doc_id', 'ref_type', 'inquiry_id', name='uq_trade_doc_inquiry_refs'),
    )


def downgrade() -> None:
    op.drop_table('trade_doc_inquiry_refs')
    op.drop_table('trade_doc_quote_refs')
