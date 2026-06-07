"""add ecommerce reconciliation models — v2 红蓝修复版

Revision ID: 202605230002
Revises: 202605230001
Create Date: 2026-05-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '202605230002'
down_revision: Union[str, None] = '202605230001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. ecommerce_platform_configs ──
    op.create_table(
        'ecommerce_platform_configs',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('platform_name', sa.Text, nullable=False),
        sa.Column('platform_display_name', sa.Text, nullable=False),
        sa.Column('platform_type', sa.Text, nullable=False),
        sa.Column('api_endpoint', sa.Text, nullable=False),
        sa.Column('api_version', sa.Text, nullable=True, server_default='v1'),
        sa.Column('credentials_encrypted', sa.Text, nullable=False),
        sa.Column('credentials_kms_key_id', sa.Text, nullable=False),
        sa.Column('credentials_encryption_context', postgresql.JSONB, nullable=False),
        sa.Column('config_params', postgresql.JSONB, nullable=True),
        sa.Column('supported_fields', postgresql.ARRAY(sa.Text), nullable=True),
        sa.Column('is_enabled', sa.Boolean, nullable=False, server_default='true'),
        sa.Column('last_sync_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('sync_status', sa.Text, nullable=True),
        sa.Column('created_by', sa.BigInteger, sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_ecom_platform_tenant', 'ecommerce_platform_configs', ['tenant_id', 'is_enabled'])
    op.create_check_constraint('chk_ecom_platform_https', 'ecommerce_platform_configs', "api_endpoint LIKE 'https://%'")

    # ── 2. logistics_provider_configs ──
    op.create_table(
        'logistics_provider_configs',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('provider_name', sa.Text, nullable=False),
        sa.Column('provider_display_name', sa.Text, nullable=False),
        sa.Column('provider_type', sa.Text, nullable=False),
        sa.Column('api_endpoint', sa.Text, nullable=False),
        sa.Column('api_version', sa.Text, nullable=True, server_default='v1'),
        sa.Column('credentials_encrypted', sa.Text, nullable=False),
        sa.Column('credentials_kms_key_id', sa.Text, nullable=False),
        sa.Column('credentials_encryption_context', postgresql.JSONB, nullable=False),
        sa.Column('config_params', postgresql.JSONB, nullable=True),
        sa.Column('supported_bill_formats', postgresql.ARRAY(sa.Text), nullable=True),
        sa.Column('is_enabled', sa.Boolean, nullable=False, server_default='true'),
        sa.Column('last_sync_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('sync_status', sa.Text, nullable=True),
        sa.Column('created_by', sa.BigInteger, sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_logistics_tenant', 'logistics_provider_configs', ['tenant_id', 'is_enabled'])
    op.create_check_constraint('chk_logistics_https', 'logistics_provider_configs', "api_endpoint LIKE 'https://%'")

    # ── 3. reconciliation_reports ──
    op.create_table(
        'reconciliation_reports',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('report_name', sa.Text, nullable=False),
        sa.Column('report_period_start', sa.Date, nullable=False),
        sa.Column('report_period_end', sa.Date, nullable=False),
        sa.Column('platform_ids', postgresql.ARRAY(sa.BigInteger), nullable=False),
        sa.Column('platform_config_snapshot', postgresql.JSONB, nullable=False),
        sa.Column('logistics_provider_ids', postgresql.ARRAY(sa.BigInteger), nullable=False),
        sa.Column('logistics_config_snapshot', postgresql.JSONB, nullable=False),
        sa.Column('total_platform_order_count', sa.Integer, nullable=False),
        sa.Column('total_platform_amount', sa.Numeric(12, 2), nullable=False),
        sa.Column('total_logistics_bill_count', sa.Integer, nullable=False),
        sa.Column('total_logistics_amount', sa.Numeric(12, 2), nullable=False),
        sa.Column('diff_summary', postgresql.JSONB, nullable=True),
        sa.Column('unmatched_platform_orders', sa.Integer, nullable=False, server_default='0'),
        sa.Column('unmatched_logistics_bills', sa.Integer, nullable=False, server_default='0'),
        sa.Column('status', sa.Text, nullable=False, server_default='pending'),
        sa.Column('triggered_by_user_id', sa.BigInteger, sa.ForeignKey('users.id'), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_recon_report_tenant', 'reconciliation_reports', ['tenant_id', 'report_period_start', 'report_period_end'])
    op.create_index('idx_recon_report_status', 'reconciliation_reports', ['tenant_id', 'status'])

    # ── 4. platform_order_staging ──
    op.create_table(
        'platform_order_staging',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('reconciliation_report_id', sa.BigInteger, sa.ForeignKey('reconciliation_reports.id', ondelete='CASCADE'), nullable=False),
        sa.Column('platform_config_id', sa.BigInteger, sa.ForeignKey('ecommerce_platform_configs.id'), nullable=False),
        sa.Column('platform_order_id', sa.Text, nullable=False),
        sa.Column('order_date', sa.Date, nullable=True),
        sa.Column('sku', sa.Text, nullable=True),
        sa.Column('quantity', sa.Integer, nullable=True),
        sa.Column('unit_price', sa.Numeric(12, 2), nullable=True),
        sa.Column('total_amount', sa.Numeric(12, 2), nullable=True),
        sa.Column('currency', sa.Text, nullable=True, server_default='CNY'),
        sa.Column('raw_data', postgresql.JSONB, nullable=False),
        sa.Column('matched_logistics_bill_id', sa.Text, nullable=True),
        sa.Column('match_confidence', sa.Numeric(5, 4), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_pos_report', 'platform_order_staging', ['reconciliation_report_id', 'platform_config_id'])
    op.create_index('idx_pos_order', 'platform_order_staging', ['tenant_id', 'platform_order_id'])

    # ── 5. logistics_bill_staging ──
    op.create_table(
        'logistics_bill_staging',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('reconciliation_report_id', sa.BigInteger, sa.ForeignKey('reconciliation_reports.id', ondelete='CASCADE'), nullable=False),
        sa.Column('logistics_config_id', sa.BigInteger, sa.ForeignKey('logistics_provider_configs.id'), nullable=False),
        sa.Column('bill_no', sa.Text, nullable=False),
        sa.Column('bill_date', sa.Date, nullable=True),
        sa.Column('waybill_no', sa.Text, nullable=True),
        sa.Column('order_id', sa.Text, nullable=True),
        sa.Column('freight_fee', sa.Numeric(12, 2), nullable=True),
        sa.Column('weight', sa.Numeric(10, 3), nullable=True),
        sa.Column('destination', sa.Text, nullable=True),
        sa.Column('raw_data', postgresql.JSONB, nullable=False),
        sa.Column('matched_platform_order_id', sa.Text, nullable=True),
        sa.Column('match_confidence', sa.Numeric(5, 4), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_lbs_report', 'logistics_bill_staging', ['reconciliation_report_id', 'logistics_config_id'])
    op.create_index('idx_lbs_bill', 'logistics_bill_staging', ['tenant_id', 'bill_no'])

    # ── 6. reconciliation_diffs ──
    op.create_table(
        'reconciliation_diffs',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('reconciliation_report_id', sa.BigInteger, sa.ForeignKey('reconciliation_reports.id', ondelete='CASCADE'), nullable=False),
        sa.Column('diff_type', sa.Text, nullable=False),
        sa.Column('platform_order_id', sa.Text, nullable=True),
        sa.Column('platform_name', sa.Text, nullable=True),
        sa.Column('platform_sku', sa.Text, nullable=True),
        sa.Column('platform_quantity', sa.Integer, nullable=True),
        sa.Column('platform_amount', sa.Numeric(12, 2), nullable=True),
        sa.Column('platform_order_date', sa.Date, nullable=True),
        sa.Column('logistics_bill_id', sa.Text, nullable=True),
        sa.Column('logistics_provider', sa.Text, nullable=True),
        sa.Column('logistics_bill_no', sa.Text, nullable=True),
        sa.Column('logistics_freight_fee', sa.Numeric(12, 2), nullable=True),
        sa.Column('logistics_bill_date', sa.Date, nullable=True),
        sa.Column('diff_amount', sa.Numeric(12, 2), nullable=True),
        sa.Column('diff_reason', sa.Text, nullable=True),
        sa.Column('resolution_status', sa.Text, nullable=False, server_default='open'),
        sa.Column('resolved_by_user_id', sa.BigInteger, sa.ForeignKey('users.id'), nullable=True),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('resolution_notes', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_recon_diff_report', 'reconciliation_diffs', ['reconciliation_report_id', 'diff_type'])
    op.create_index('idx_recon_diff_resolution', 'reconciliation_diffs', ['tenant_id', 'resolution_status'])
    op.create_index('idx_recon_diff_platform_order', 'reconciliation_diffs', ['tenant_id', 'platform_order_id'])
    op.create_index('idx_recon_diff_logistics_bill', 'reconciliation_diffs', ['tenant_id', 'logistics_bill_id'])


def downgrade() -> None:
    op.drop_table('reconciliation_diffs')
    op.drop_table('logistics_bill_staging')
    op.drop_table('platform_order_staging')
    op.drop_table('reconciliation_reports')
    op.drop_table('logistics_provider_configs')
    op.drop_table('ecommerce_platform_configs')
