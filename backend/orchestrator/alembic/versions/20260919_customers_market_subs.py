"""customers_market_subscriptions

Revision ID: 20260919_customers_market_subs
Revises: 20260919_workstation_links
Create Date: 2026-09-19

为客户管理工位 / 产品市场对照工位 / 订阅体系 建表（仅建表，业务逻辑后续填充）。
依据 docs/WORKSTATION_DESIGN.md §5.4 / §6.4 / §6.5。

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '20260919_customers_market_subs'
down_revision: Union[str, None] = '20260919_workstation_links'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 订阅体系 ─────────────────────────────────────────────────────────────

    op.create_table(
        'subscription_bundles',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('bundle_code', sa.Text(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('plan_codes', postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column('price_cny', sa.Numeric(10, 2), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('bundle_code', name='uq_subscription_bundles_code'),
    )

    op.create_table(
        'subscriptions',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('plan_code', sa.Text(), nullable=False),
        sa.Column('plan_type', sa.Text(), nullable=False, server_default='single'),
        sa.Column('bundle_code', sa.Text(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='active'),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'uq_subscriptions_tenant_plan_active',
        'subscriptions',
        ['tenant_id', 'plan_code'],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )

    # ── 客户管理工位 ──────────────────────────────────────────────────────────

    op.create_table(
        'cust_customers',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('company_name', sa.Text(), nullable=False),
        sa.Column('country', sa.Text(), nullable=True),
        sa.Column('address', sa.Text(), nullable=True),
        sa.Column('default_port', sa.Text(), nullable=True),
        sa.Column('credit_level', sa.Text(), nullable=True),
        sa.Column('stage', sa.Text(), nullable=False, server_default='lead'),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_by', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_cust_customers_tenant_stage', 'cust_customers', ['tenant_id', 'stage'], unique=False)
    op.create_index('idx_cust_customers_tenant_country', 'cust_customers', ['tenant_id', 'country'], unique=False)

    op.create_table(
        'cust_contacts',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('customer_id', sa.BigInteger(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('position', sa.Text(), nullable=True),
        sa.Column('phone', sa.Text(), nullable=True),
        sa.Column('email', sa.Text(), nullable=True),
        sa.Column('whatsapp', sa.Text(), nullable=True),
        sa.Column('wechat', sa.Text(), nullable=True),
        sa.Column('is_primary', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['customer_id'], ['cust_customers.id'], ondelete='CASCADE'),
    )
    op.create_index('idx_cust_contacts_customer', 'cust_contacts', ['customer_id'], unique=False)

    op.create_table(
        'cust_inquiries',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('customer_id', sa.BigInteger(), nullable=False),
        sa.Column('channel', sa.Text(), nullable=True),
        sa.Column('category_id', sa.BigInteger(), nullable=True),
        sa.Column('product_name_raw', sa.Text(), nullable=True),
        sa.Column('quantity', sa.Numeric(), nullable=True),
        sa.Column('quantity_unit', sa.Text(), nullable=True),
        sa.Column('application', sa.Text(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='inquiry'),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_by', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['customer_id'], ['cust_customers.id'], ondelete='CASCADE'),
    )
    op.create_index('idx_cust_inquiries_customer', 'cust_inquiries', ['customer_id', 'status'], unique=False)
    op.create_index('idx_cust_inquiries_tenant_status', 'cust_inquiries', ['tenant_id', 'status'], unique=False)

    op.create_table(
        'cust_stage_log',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('customer_id', sa.BigInteger(), nullable=False),
        sa.Column('from_stage', sa.Text(), nullable=True),
        sa.Column('to_stage', sa.Text(), nullable=False),
        sa.Column('changed_by', sa.Text(), nullable=True),
        sa.Column('reason', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['customer_id'], ['cust_customers.id'], ondelete='CASCADE'),
    )
    op.create_index('idx_cust_stage_log_customer', 'cust_stage_log', ['customer_id'], unique=False)

    # ── 产品市场对照工位 ──────────────────────────────────────────────────────

    op.create_table(
        'market_region_products',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('region_code', sa.Text(), nullable=False),
        sa.Column('category_id', sa.BigInteger(), nullable=True),
        sa.Column('demand_level', sa.Text(), nullable=True),
        sa.Column('popularity_rank', sa.Integer(), nullable=True),
        sa.Column('cert_requirements', postgresql.JSONB(), nullable=True),
        sa.Column('standards', postgresql.JSONB(), nullable=True),
        sa.Column('seasonality', sa.Text(), nullable=True),
        sa.Column('source', sa.Text(), nullable=False, server_default='manual'),
        sa.Column('confidence', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'region_code', 'category_id', name='uq_market_region_products'),
    )
    op.create_index('idx_market_region_products_lookup', 'market_region_products', ['tenant_id', 'region_code'], unique=False)

    op.create_table(
        'market_region_product_specs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('market_product_id', sa.BigInteger(), nullable=False),
        sa.Column('spec_key', sa.Text(), nullable=False),
        sa.Column('spec_value', sa.Text(), nullable=False),
        sa.Column('unit', sa.Text(), nullable=True),
        sa.Column('frequency_rank', sa.Integer(), nullable=True),
        sa.Column('sku_id', sa.BigInteger(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['market_product_id'], ['market_region_products.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('market_product_id', 'spec_key', 'spec_value', name='uq_market_region_product_specs'),
    )
    op.create_index('idx_market_specs_product', 'market_region_product_specs', ['market_product_id'], unique=False)

    op.create_table(
        'market_product_name_mappings',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('category_id', sa.BigInteger(), nullable=True),
        sa.Column('region_code', sa.Text(), nullable=False),
        sa.Column('lang', sa.Text(), nullable=False),
        sa.Column('local_name', sa.Text(), nullable=False),
        sa.Column('alt_names', postgresql.JSONB(), nullable=True),
        sa.Column('hs_code', sa.Text(), nullable=True),
        sa.Column('source', sa.Text(), nullable=False, server_default='manual'),
        sa.Column('confidence', sa.Text(), nullable=True),
        sa.Column('is_verified', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'category_id', 'region_code', 'lang', name='uq_market_name_mappings'),
    )
    op.create_index('idx_market_name_mappings_lookup', 'market_product_name_mappings', ['tenant_id', 'region_code', 'lang'], unique=False)

    op.create_table(
        'market_product_usages',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('usage_code', sa.Text(), nullable=False),
        sa.Column('usage_name', sa.Text(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'usage_code', name='uq_market_product_usages'),
    )

    op.create_table(
        'market_product_usage_mappings',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('category_id', sa.BigInteger(), nullable=False),
        sa.Column('usage_id', sa.BigInteger(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['usage_id'], ['market_product_usages.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('tenant_id', 'category_id', 'usage_id', name='uq_market_usage_mappings'),
    )

    op.create_table(
        'market_ports',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('name_cn', sa.Text(), nullable=False),
        sa.Column('name_en', sa.Text(), nullable=False),
        sa.Column('un_locode', sa.Text(), nullable=True),
        sa.Column('country_code', sa.Text(), nullable=False),
        sa.Column('city', sa.Text(), nullable=True),
        sa.Column('lat', sa.Numeric(9, 6), nullable=True),
        sa.Column('lng', sa.Numeric(9, 6), nullable=True),
        sa.Column('port_type', sa.Text(), nullable=True),
        sa.Column('position_desc', sa.Text(), nullable=True),
        sa.Column('characteristics', sa.Text(), nullable=True),
        sa.Column('berth_depth_m', sa.Numeric(6, 2), nullable=True),
        sa.Column('max_vessel_size', sa.Text(), nullable=True),
        sa.Column('suitable_cargo', postgresql.JSONB(), nullable=True),
        sa.Column('suitable_shipping_modes', postgresql.JSONB(), nullable=True),
        sa.Column('connected_corridors', postgresql.JSONB(), nullable=True),
        sa.Column('throughput_rank', sa.Integer(), nullable=True),
        sa.Column('congestion_level', sa.Text(), nullable=True),
        sa.Column('major_carriers', postgresql.JSONB(), nullable=True),
        sa.Column('avg_dwell_days', sa.Numeric(4, 1), nullable=True),
        sa.Column('port_charges_level', sa.Text(), nullable=True),
        sa.Column('last_verified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('source', sa.Text(), nullable=False, server_default='manual'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_market_ports_country', 'market_ports', ['country_code'], unique=False)
    op.create_index('idx_market_ports_locode', 'market_ports', ['un_locode'], unique=False)


def downgrade() -> None:
    op.drop_table('market_ports')
    op.drop_table('market_product_usage_mappings')
    op.drop_table('market_product_usages')
    op.drop_table('market_product_name_mappings')
    op.drop_table('market_region_product_specs')
    op.drop_table('market_region_products')
    op.drop_table('cust_stage_log')
    op.drop_table('cust_inquiries')
    op.drop_table('cust_contacts')
    op.drop_table('cust_customers')
    op.drop_table('subscriptions')
    op.drop_table('subscription_bundles')
