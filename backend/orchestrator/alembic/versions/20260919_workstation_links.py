"""workstation_links

Revision ID: 20260919_workstation_links
Revises: 60642caa63f5
Create Date: 2026-09-19

为报价工位 / 订单工位 / 外贸票据工位 建立数据库口子（仅建表，业务逻辑后续填充）。
依据 docs/WORKSTATION_DESIGN.md §5-§6。

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '20260919_workstation_links'
down_revision: Union[str, None] = '60642caa63f5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 报价工位 ──────────────────────────────────────────────────────────────
    op.create_table(
        'quote_orders',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('quote_no', sa.Text(), nullable=False),
        sa.Column('customer_id', sa.Text(), nullable=True),
        sa.Column('customer_name', sa.Text(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='draft'),
        sa.Column('currency', sa.Text(), nullable=False, server_default='USD'),
        sa.Column('total_amount', sa.Numeric(), nullable=True),
        sa.Column('valid_until', sa.DateTime(timezone=True), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_by', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('quote_no', name='uq_quote_orders_quote_no'),
    )
    op.create_index('idx_quote_orders_tenant', 'quote_orders', ['tenant_id', 'status'], unique=False)
    op.create_index('idx_quote_orders_customer', 'quote_orders', ['tenant_id', 'customer_id'], unique=False)

    op.create_table(
        'quote_order_items',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('quote_order_id', sa.BigInteger(), nullable=False),
        sa.Column('sku_id', sa.BigInteger(), nullable=True),
        sa.Column('product_name', sa.Text(), nullable=True),
        sa.Column('spec_snapshot', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('qty', sa.Numeric(), nullable=False, server_default='1'),
        sa.Column('qty_unit', sa.Text(), nullable=True),
        sa.Column('unit_price', sa.Numeric(), nullable=True),
        sa.Column('currency', sa.Text(), nullable=False, server_default='USD'),
        sa.Column('line_amount', sa.Numeric(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_quote_order_items_quote', 'quote_order_items', ['tenant_id', 'quote_order_id'], unique=False)

    # ── 订单工位 ──────────────────────────────────────────────────────────────
    op.create_table(
        'orders',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('order_no', sa.Text(), nullable=False),
        sa.Column('customer_id', sa.Text(), nullable=True),
        sa.Column('customer_name', sa.Text(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='pending'),
        sa.Column('currency', sa.Text(), nullable=False, server_default='USD'),
        sa.Column('total_amount', sa.Numeric(), nullable=True),
        sa.Column('order_date', sa.DateTime(timezone=True), nullable=True),
        sa.Column('delivery_date', sa.DateTime(timezone=True), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_by', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('order_no', name='uq_orders_order_no'),
    )
    op.create_index('idx_orders_tenant', 'orders', ['tenant_id', 'status'], unique=False)
    op.create_index('idx_orders_customer', 'orders', ['tenant_id', 'customer_id'], unique=False)

    op.create_table(
        'order_items',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('order_id', sa.BigInteger(), nullable=False),
        sa.Column('sku_id', sa.BigInteger(), nullable=True),
        sa.Column('product_name', sa.Text(), nullable=True),
        sa.Column('spec_snapshot', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('qty', sa.Numeric(), nullable=False, server_default='1'),
        sa.Column('qty_unit', sa.Text(), nullable=True),
        sa.Column('unit_price', sa.Numeric(), nullable=True),
        sa.Column('currency', sa.Text(), nullable=False, server_default='USD'),
        sa.Column('line_amount', sa.Numeric(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_order_items_order', 'order_items', ['tenant_id', 'order_id'], unique=False)

    # ── 外贸票据工位 ───────────────────────────────────────────────────────────
    op.create_table(
        'trade_docs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('doc_no', sa.Text(), nullable=False),
        sa.Column('doc_type', sa.Text(), nullable=False),
        sa.Column('order_id', sa.BigInteger(), nullable=True),
        sa.Column('customer_id', sa.Text(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='draft'),
        sa.Column('currency', sa.Text(), nullable=False, server_default='USD'),
        sa.Column('total_amount', sa.Numeric(), nullable=True),
        sa.Column('issued_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('issued_by', sa.Text(), nullable=True),
        sa.Column('raw_payload', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('doc_no', name='uq_trade_docs_doc_no'),
    )
    op.create_index('idx_trade_docs_tenant', 'trade_docs', ['tenant_id', 'doc_type', 'status'], unique=False)
    op.create_index('idx_trade_docs_order', 'trade_docs', ['tenant_id', 'order_id'], unique=False)

    op.create_table(
        'trade_doc_items',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('trade_doc_id', sa.BigInteger(), nullable=False),
        sa.Column('order_item_id', sa.BigInteger(), nullable=True),
        sa.Column('product_name', sa.Text(), nullable=True),
        sa.Column('spec_snapshot', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('qty', sa.Numeric(), nullable=False, server_default='1'),
        sa.Column('qty_unit', sa.Text(), nullable=True),
        sa.Column('unit_price', sa.Numeric(), nullable=True),
        sa.Column('currency', sa.Text(), nullable=False, server_default='USD'),
        sa.Column('line_amount', sa.Numeric(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_trade_doc_items_doc', 'trade_doc_items', ['tenant_id', 'trade_doc_id'], unique=False)

    # ── 跨工位关联表 ───────────────────────────────────────────────────────────
    op.create_table(
        'quote_order_shipment_refs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('quote_order_id', sa.BigInteger(), nullable=False),
        sa.Column('shipment_id', sa.BigInteger(), nullable=False),
        sa.Column('ref_type', sa.Text(), nullable=False, server_default='buyer_signal'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'quote_order_id', 'ref_type', 'shipment_id', name='uq_quote_order_shipment_refs'),
    )

    op.create_table(
        'order_quote_refs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('order_id', sa.BigInteger(), nullable=False),
        sa.Column('quote_order_id', sa.BigInteger(), nullable=False),
        sa.Column('ref_type', sa.Text(), nullable=False, server_default='converted_from'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'order_id', 'ref_type', 'quote_order_id', name='uq_order_quote_refs'),
    )

    op.create_table(
        'order_shipment_refs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('order_id', sa.BigInteger(), nullable=False),
        sa.Column('shipment_id', sa.BigInteger(), nullable=False),
        sa.Column('ref_type', sa.Text(), nullable=False, server_default='actual_shipment'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'order_id', 'ref_type', 'shipment_id', name='uq_order_shipment_refs'),
    )

    op.create_table(
        'trade_doc_order_refs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('trade_doc_id', sa.BigInteger(), nullable=False),
        sa.Column('order_id', sa.BigInteger(), nullable=False),
        sa.Column('ref_type', sa.Text(), nullable=False, server_default='generated_from'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'trade_doc_id', 'ref_type', 'order_id', name='uq_trade_doc_order_refs'),
    )


def downgrade() -> None:
    op.drop_table('trade_doc_order_refs')
    op.drop_table('order_shipment_refs')
    op.drop_table('order_quote_refs')
    op.drop_table('quote_order_shipment_refs')
    op.drop_index('idx_trade_doc_items_doc', table_name='trade_doc_items')
    op.drop_table('trade_doc_items')
    op.drop_index('idx_trade_docs_order', table_name='trade_docs')
    op.drop_index('idx_trade_docs_tenant', table_name='trade_docs')
    op.drop_table('trade_docs')
    op.drop_index('idx_order_items_order', table_name='order_items')
    op.drop_table('order_items')
    op.drop_index('idx_orders_customer', table_name='orders')
    op.drop_index('idx_orders_tenant', table_name='orders')
    op.drop_table('orders')
    op.drop_index('idx_quote_order_items_quote', table_name='quote_order_items')
    op.drop_table('quote_order_items')
    op.drop_index('idx_quote_orders_customer', table_name='quote_orders')
    op.drop_index('idx_quote_orders_tenant', table_name='quote_orders')
    op.drop_table('quote_orders')
