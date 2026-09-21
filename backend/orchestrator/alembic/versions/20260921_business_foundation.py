"""business_foundation

Revision ID: 20260921_business_foundation
Revises: 20260921_trade_doc_upstream_refs
Create Date: 2026-09-21

Phase 2.5 基础设计落地（见 docs/WORKSTATION_DESIGN.md §10 / §12）：
- fx_rates          汇率表（§10.2）
- doc_sequences     单据号序列（§10.7）
- shipments         自有出运台账（§10.6，区别于 intel_shipments 海关情报）
- payment_schedules 付款计划，只记阶段不做收付款（§10.5）
- receivables       应收台账（§10.2 外币应收本币折算）
- units / unit_conversions  单位字典 + SKU 换算（§10.8）
- owner_id / owner_scope    数据可见范围字段补齐（§10.3）
- cust_inquiries.status     枚举对齐：'inquiry' → 'open'（§10.1 / §10.4）
- quote_orders / orders     补 fx_rate / fx_rate_date 汇率快照列（§10.2 / 不变量13）

仅建表/加列，不改历史列（遵守不变量6）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '20260921_business_foundation'
down_revision: Union[str, None] = '20260921_trade_doc_upstream_refs'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 汇率表 fx_rates（§10.2）────────────────────────────────────────────
    op.create_table(
        'fx_rates',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('base_currency', sa.Text(), nullable=False),   # 基准币，如 'CNY'
        sa.Column('quote_currency', sa.Text(), nullable=False),  # 目标币，如 'USD'
        sa.Column('rate', sa.Numeric(20, 8), nullable=False),    # 1 base = rate quote
        sa.Column('rate_date', sa.Date(), nullable=False),       # 交易日
        sa.Column('source', sa.Text(), nullable=True),
        sa.Column('is_stale', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('fetched_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('base_currency', 'quote_currency', 'rate_date', name='uq_fx_rates_pair_date'),
    )
    op.create_index('idx_fx_rates_lookup', 'fx_rates', ['base_currency', 'quote_currency', 'rate_date'], unique=False)

    # ── 单据号序列 doc_sequences（§10.7）───────────────────────────────────
    op.create_table(
        'doc_sequences',
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('doc_type', sa.Text(), nullable=False),   # 'pi'|'ci'|'quote'|'order'|'shipment'...
        sa.Column('period', sa.Text(), nullable=False),     # '202609' 按月分段
        sa.Column('last_seq', sa.Integer(), nullable=False, server_default='0'),
        sa.PrimaryKeyConstraint('tenant_id', 'doc_type', 'period'),
    )

    # ── 自有出运台账 shipments（§10.6）─────────────────────────────────────
    op.create_table(
        'shipments',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('shipment_no', sa.Text(), nullable=False),
        sa.Column('order_id', sa.BigInteger(), nullable=True),
        sa.Column('customer_id', sa.BigInteger(), nullable=True),
        # 客户当时快照（防关联变更导致历史失真，目标是还原当时具体情况）
        sa.Column('customer_name', sa.Text(), nullable=True),
        sa.Column('consignee', sa.Text(), nullable=True),
        sa.Column('notify_party', sa.Text(), nullable=True),
        # 货物当时快照
        sa.Column('cargo_desc', sa.Text(), nullable=True),
        sa.Column('cargo_qty', sa.Numeric(), nullable=True),
        sa.Column('cargo_qty_unit', sa.Text(), nullable=True),
        sa.Column('cargo_weight_kg', sa.Numeric(), nullable=True),
        sa.Column('cargo_volume_cbm', sa.Numeric(), nullable=True),
        # 物流信息
        sa.Column('pol', sa.Text(), nullable=True),            # 起运港 un_locode
        sa.Column('pod', sa.Text(), nullable=True),            # 目的港 un_locode
        sa.Column('pol_name', sa.Text(), nullable=True),
        sa.Column('pod_name', sa.Text(), nullable=True),
        sa.Column('vessel', sa.Text(), nullable=True),
        sa.Column('voyage', sa.Text(), nullable=True),
        sa.Column('container_no', sa.Text(), nullable=True),
        sa.Column('so_no', sa.Text(), nullable=True),
        sa.Column('booking_no', sa.Text(), nullable=True),
        sa.Column('bl_no', sa.Text(), nullable=True),
        sa.Column('bl_type', sa.Text(), nullable=True),        # 'original'|'telex'|'seaway'
        sa.Column('etd', sa.Date(), nullable=True),
        sa.Column('eta', sa.Date(), nullable=True),
        sa.Column('atd', sa.Date(), nullable=True),
        sa.Column('ata', sa.Date(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='booking'),
        sa.Column('freight_remark', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('owner_id', sa.Text(), nullable=True),
        sa.Column('owner_scope', sa.Text(), nullable=False, server_default='private'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('shipment_no', name='uq_shipments_shipment_no'),
    )
    op.create_index('idx_shipments_tenant_status', 'shipments', ['tenant_id', 'status'], unique=False)
    op.create_index('idx_shipments_order', 'shipments', ['tenant_id', 'order_id'], unique=False)

    # ── 付款计划 payment_schedules（§10.5，只记阶段不做收付款执行）──────────
    op.create_table(
        'payment_schedules',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('order_id', sa.BigInteger(), nullable=True),
        sa.Column('trade_doc_id', sa.BigInteger(), nullable=True),
        sa.Column('schedule_type', sa.Text(), nullable=False),  # 'deposit'|'balance'|'full'
        sa.Column('ratio', sa.Numeric(5, 4), nullable=True),    # 比例（0.3=30%），与 amount 二选一
        sa.Column('amount', sa.Numeric(14, 2), nullable=True),
        sa.Column('currency', sa.Text(), nullable=False, server_default='USD'),
        sa.Column('due_date', sa.Date(), nullable=True),
        sa.Column('actual_date', sa.Date(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='pending'),  # 'pending'|'paid'|'overdue'
        sa.Column('fx_rate', sa.Numeric(20, 8), nullable=True),           # 实际收汇汇率
        sa.Column('exchange_gain_loss', sa.Numeric(14, 2), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('owner_id', sa.Text(), nullable=True),
        sa.Column('owner_scope', sa.Text(), nullable=False, server_default='private'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_payment_schedules_order', 'payment_schedules', ['tenant_id', 'order_id'], unique=False)

    # ── 应收台账 receivables（§10.2）───────────────────────────────────────
    op.create_table(
        'receivables',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('order_id', sa.BigInteger(), nullable=False),
        sa.Column('currency', sa.Text(), nullable=False, server_default='USD'),       # 原币
        sa.Column('total_amount', sa.Numeric(14, 2), nullable=False, server_default='0'),
        sa.Column('fx_rate', sa.Numeric(20, 8), nullable=True),                        # 订单锁定汇率
        sa.Column('fx_rate_date', sa.Date(), nullable=True),
        sa.Column('base_currency', sa.Text(), nullable=False, server_default='CNY'),  # 本币
        sa.Column('base_amount', sa.Numeric(14, 2), nullable=True),                    # 本币折算应收
        sa.Column('received_amount', sa.Numeric(14, 2), nullable=False, server_default='0'),  # 原币已收
        sa.Column('exchange_gain_loss', sa.Numeric(14, 2), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='unpaid'),      # 'unpaid'|'partial'|'paid'
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('owner_id', sa.Text(), nullable=True),
        sa.Column('owner_scope', sa.Text(), nullable=False, server_default='private'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'order_id', name='uq_receivables_order'),
    )

    # ── SKU 级单位换算 unit_conversions（§10.8）────────────────────────────
    # 注意：单位字典复用规格系统已有的全局 units/unit_groups 表（code PK +
    # to_base_factor 全局换算），此处只建租户级 SKU 换算表。
    op.create_table(
        'unit_conversions',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('sku_id', sa.BigInteger(), nullable=False),
        sa.Column('from_unit', sa.Text(), nullable=False),
        sa.Column('to_unit', sa.Text(), nullable=False),       # 通常 = SKU base_unit
        sa.Column('factor', sa.Numeric(20, 8), nullable=False),  # 1 from_unit = factor to_unit
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'sku_id', 'from_unit', 'to_unit', name='uq_unit_conversions'),
    )

    # ── 数据可见范围 owner_id / owner_scope 字段补齐（§10.3）────────────────
    _owner_scope_tables = ['cust_customers', 'cust_inquiries', 'quote_orders', 'orders', 'trade_docs']
    for t in _owner_scope_tables:
        op.add_column(t, sa.Column('owner_id', sa.Text(), nullable=True))
        op.add_column(t, sa.Column('owner_scope', sa.Text(), nullable=False, server_default='private'))

    # ── 询盘状态枚举对齐：'inquiry' → 'open'（§10.1 / §10.4）────────────────
    op.alter_column('cust_inquiries', 'status', server_default='open')
    op.execute("UPDATE cust_inquiries SET status='open' WHERE status='inquiry'")

    # ── 报价单 / 订单 汇率快照列（§10.2 / 不变量13）────────────────────────
    op.add_column('quote_orders', sa.Column('fx_rate', sa.Numeric(20, 8), nullable=True))
    op.add_column('quote_orders', sa.Column('fx_rate_date', sa.Date(), nullable=True))
    op.add_column('orders', sa.Column('fx_rate', sa.Numeric(20, 8), nullable=True))
    op.add_column('orders', sa.Column('fx_rate_date', sa.Date(), nullable=True))

    # ── 种子单位字典：写入规格系统已有的全局 units / unit_groups（当前为空表）──
    _unit_groups = [
        ('area', '面积', 'sqm'),
        ('length', '长度', 'm'),
        ('weight', '重量', 'kg'),
        ('count', '数量', 'pcs'),
        ('volume', '体积', 'cbm'),
    ]
    for code, name, base in _unit_groups:
        op.execute(
            "INSERT INTO unit_groups (code, name, base_unit) VALUES ('%s', '%s', '%s') "
            "ON CONFLICT (code) DO NOTHING" % (code, name, base)
        )

    _system_units = [
        # (code, label, group, to_base_factor, sort_order)
        ('sqm', '平方米', 'area', 1, 1),
        ('m', '米', 'length', 1, 1),
        ('kg', '千克', 'weight', 1, 1),
        ('ton', '吨', 'weight', 1000, 2),
        ('pcs', '件', 'count', 1, 1),
        ('roll', '卷', 'count', 1, 2),
        ('bundle', '捆', 'count', 1, 3),
        ('pallet', '托', 'count', 1, 4),
        ('bag', '袋', 'count', 1, 5),
        ('cbm', '立方米', 'volume', 1, 1),
    ]
    for code, label, grp, factor, sort in _system_units:
        op.execute(
            "INSERT INTO units (code, label, unit_group, to_base_factor, sort_order) "
            "VALUES ('%s', '%s', '%s', %s, %s) ON CONFLICT (code) DO NOTHING"
            % (code, label, grp, factor, sort)
        )


def downgrade() -> None:
    op.drop_table('unit_conversions')
    op.drop_table('receivables')
    op.drop_index('idx_payment_schedules_order', table_name='payment_schedules')
    op.drop_table('payment_schedules')
    op.drop_index('idx_shipments_order', table_name='shipments')
    op.drop_index('idx_shipments_tenant_status', table_name='shipments')
    op.drop_table('shipments')
    op.drop_table('doc_sequences')
    op.drop_index('idx_fx_rates_lookup', table_name='fx_rates')
    op.drop_table('fx_rates')

    for t in ['cust_customers', 'cust_inquiries', 'quote_orders', 'orders', 'trade_docs']:
        op.drop_column(t, 'owner_scope')
        op.drop_column(t, 'owner_id')

    op.drop_column('orders', 'fx_rate_date')
    op.drop_column('orders', 'fx_rate')
    op.drop_column('quote_orders', 'fx_rate_date')
    op.drop_column('quote_orders', 'fx_rate')
