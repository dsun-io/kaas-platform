"""add financial workstation models — v2 红蓝修复版

Revision ID: 202605230001
Revises: 202605220001
Create Date: 2026-05-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '202605230001'
down_revision: Union[str, None] = '202605220001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. customer_invoice_headers ──
    op.create_table(
        'customer_invoice_headers',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('customer_id', sa.BigInteger, sa.ForeignKey('customers.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('company_name', sa.Text, nullable=False),
        sa.Column('uscc', sa.Text, nullable=True),
        sa.Column('tax_id', sa.Text, nullable=False),
        sa.Column('verification_status', sa.Text, nullable=False, server_default='pending'),
        sa.Column('verification_source', sa.Text, nullable=True),
        sa.Column('verification_checked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('verification_response', postgresql.JSONB, nullable=True),
        sa.Column('registered_address', sa.Text, nullable=False),
        sa.Column('registered_province', sa.Text, nullable=True),
        sa.Column('registered_city', sa.Text, nullable=True),
        sa.Column('phone_number', sa.Text, nullable=True),
        sa.Column('bank_name', sa.Text, nullable=True),
        sa.Column('bank_account_encrypted', sa.Text, nullable=True),
        sa.Column('bank_account_kms_key_id', sa.Text, nullable=True),
        sa.Column('is_primary', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('status', sa.Text, nullable=False, server_default='active'),
        sa.Column('effective_from', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('effective_to', sa.DateTime(timezone=True), nullable=True),
        sa.Column('previous_version_id', sa.BigInteger, nullable=True),
        sa.Column('created_by', sa.BigInteger, sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_invoice_header_customer', 'customer_invoice_headers', ['customer_id', 'is_primary'])
    op.create_index('idx_invoice_header_tax_id', 'customer_invoice_headers', ['tax_id'])
    op.create_index('idx_invoice_header_active', 'customer_invoice_headers', ['customer_id', 'status', 'effective_to'])
    op.create_index('idx_invoice_header_tenant', 'customer_invoice_headers', ['tenant_id'])

    # ── 2. invoice_platform_configs ──
    op.create_table(
        'invoice_platform_configs',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('platform_name', sa.Text, nullable=False),
        sa.Column('platform_display_name', sa.Text, nullable=False),
        sa.Column('api_endpoint', sa.Text, nullable=False),
        sa.Column('api_version', sa.Text, nullable=True, server_default='v1'),
        sa.Column('credentials_encrypted', sa.Text, nullable=False),
        sa.Column('credentials_kms_key_id', sa.Text, nullable=False),
        sa.Column('credentials_encryption_context', postgresql.JSONB, nullable=False),
        sa.Column('config_params', postgresql.JSONB, nullable=True),
        sa.Column('is_enabled', sa.Boolean, nullable=False, server_default='true'),
        sa.Column('is_primary', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('last_health_check_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('health_check_status', sa.Text, nullable=True),
        sa.Column('health_check_error_msg', sa.Text, nullable=True),
        sa.Column('daily_quota', sa.Integer, nullable=True),
        sa.Column('daily_used_count', sa.Integer, nullable=False, server_default='0'),
        sa.Column('quota_reset_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', sa.BigInteger, sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_platform_config_tenant', 'invoice_platform_configs', ['tenant_id', 'is_enabled'])
    op.create_index('idx_platform_config_primary', 'invoice_platform_configs', ['tenant_id', 'is_primary'])
    op.create_check_constraint('chk_platform_https', 'invoice_platform_configs', "api_endpoint LIKE 'https://%'")

    # ── 3. invoice_templates ──
    op.create_table(
        'invoice_templates',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('customer_id', sa.BigInteger, nullable=True),
        sa.Column('tax_code', sa.Text, nullable=False),
        sa.Column('tax_code_name', sa.Text, nullable=False),
        sa.Column('nickname', sa.Text, nullable=False),
        sa.Column('synonyms', postgresql.ARRAY(sa.Text), nullable=True),
        sa.Column('default_tax_rate', sa.Numeric(5, 4), nullable=False),
        sa.Column('tax_rate_options', postgresql.ARRAY(sa.Numeric(5, 4)), nullable=True),
        sa.Column('default_unit', sa.Text, nullable=False, server_default='项'),
        sa.Column('unit_options', postgresql.ARRAY(sa.Text), nullable=True),
        sa.Column('category', sa.Text, nullable=True),
        sa.Column('sub_category', sa.Text, nullable=True),
        sa.Column('priority_score', sa.Integer, nullable=False, server_default='0'),
        sa.Column('usage_count', sa.Integer, nullable=False, server_default='0'),
        sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status', sa.Text, nullable=False, server_default='active'),
        sa.Column('created_by', sa.BigInteger, sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_template_tenant_category', 'invoice_templates', ['tenant_id', 'category'])
    op.create_index('idx_template_tax_code', 'invoice_templates', ['tax_code'])
    op.create_index('idx_template_priority', 'invoice_templates', ['priority_score', 'usage_count'])
    op.create_index('idx_template_tenant', 'invoice_templates', ['tenant_id'])

    # ── 4. invoice_requests ──
    op.create_table(
        'invoice_requests',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('customer_id', sa.BigInteger, sa.ForeignKey('customers.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('wechat_message_id', sa.Text, nullable=False, unique=True),
        sa.Column('from_wechat_user_id', sa.Text, nullable=False),
        sa.Column('from_wechat_username', sa.Text, nullable=True),
        sa.Column('wechat_bot_account_id', sa.BigInteger, sa.ForeignKey('wechat_bot_accounts.id'), nullable=False),
        sa.Column('wechat_conversation_id', sa.BigInteger, sa.ForeignKey('wechat_conversations.id'), nullable=False),
        sa.Column('raw_message_content', sa.Text, nullable=False),
        sa.Column('message_type', sa.Text, nullable=False),
        sa.Column('attached_image_urls', postgresql.ARRAY(sa.Text), nullable=True),
        sa.Column('voice_transcription', sa.Text, nullable=True),
        sa.Column('extracted_data', postgresql.JSONB, nullable=True),
        sa.Column('extraction_confidence', sa.Numeric(5, 4), nullable=True),
        sa.Column('extraction_issues', postgresql.JSONB, nullable=True),
        sa.Column('matched_customer_header_id', sa.BigInteger, sa.ForeignKey('customer_invoice_headers.id'), nullable=True),
        sa.Column('merged_invoice_params', postgresql.JSONB, nullable=True),
        sa.Column('extracted_data_override', postgresql.JSONB, nullable=True),
        sa.Column('override_reason', sa.Text, nullable=True),
        sa.Column('override_approved_by', sa.BigInteger, sa.ForeignKey('users.id'), nullable=True),
        sa.Column('override_approved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('invoice_platform_config_id', sa.BigInteger, sa.ForeignKey('invoice_platform_configs.id'), nullable=True),
        sa.Column('invoice_record_id', sa.BigInteger, sa.ForeignKey('invoice_records.id'), nullable=True),
        sa.Column('status', sa.Text, nullable=False, server_default='pending_extraction'),
        sa.Column('version', sa.Integer, nullable=False, server_default='1'),
        sa.Column('confirmed_by_user_id', sa.BigInteger, sa.ForeignKey('users.id'), nullable=True),
        sa.Column('confirmation_timestamp', sa.DateTime(timezone=True), nullable=True),
        sa.Column('confirmation_notes', sa.Text, nullable=True),
        sa.Column('rejection_reason', sa.Text, nullable=True),
        sa.Column('resubmitted_from_id', sa.BigInteger, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('extraction_completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('confirmation_deadline', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('trace_id', sa.Text, nullable=True),
        sa.Column('sampled', sa.Boolean, nullable=False, server_default='true'),
    )
    op.create_index('idx_invoice_request_tenant_status', 'invoice_requests', ['tenant_id', 'status'])
    op.create_index('idx_invoice_request_customer', 'invoice_requests', ['customer_id', 'created_at'])
    op.create_index('idx_invoice_request_wechat_msg', 'invoice_requests', ['wechat_message_id'])
    op.create_index('idx_invoice_request_conv', 'invoice_requests', ['wechat_conversation_id'])
    op.create_index('idx_invoice_request_deadline', 'invoice_requests', ['confirmation_deadline'])
    op.create_unique_constraint('uq_invoice_request_record', 'invoice_requests', ['invoice_record_id'])

    # ── 5. invoice_records ──
    op.create_table(
        'invoice_records',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('invoice_request_id', sa.BigInteger, sa.ForeignKey('invoice_requests.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('invoice_number', sa.Text, nullable=False, unique=True),
        sa.Column('invoice_type', sa.Text, nullable=False),
        sa.Column('invoice_date', sa.Date, nullable=False),
        sa.Column('amount', sa.Numeric(12, 2), nullable=False),
        sa.Column('tax_amount', sa.Numeric(12, 2), nullable=False),
        sa.Column('total_amount', sa.Numeric(12, 2), nullable=False),
        sa.Column('pdf_url', sa.Text, nullable=True),
        sa.Column('pdf_hash', sa.Text, nullable=True),
        sa.Column('pdf_page_count', sa.Integer, nullable=True),
        sa.Column('platform_request_id', sa.Text, nullable=True),
        sa.Column('platform_response', postgresql.JSONB, nullable=True),
        sa.Column('status', sa.Text, nullable=False, server_default='issued'),
        sa.Column('confirmed_by_user_id', sa.BigInteger, sa.ForeignKey('users.id'), nullable=False),
        sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_invoice_record_tenant', 'invoice_records', ['tenant_id', 'invoice_date'])
    op.create_index('idx_invoice_record_request', 'invoice_records', ['invoice_request_id'])
    op.create_index('idx_invoice_record_number', 'invoice_records', ['invoice_number'])

    # ── 6. financial_workstation_sessions ──
    op.create_table(
        'financial_workstation_sessions',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('invoice_request_id', sa.BigInteger, sa.ForeignKey('invoice_requests.id', ondelete='CASCADE'), nullable=False),
        sa.Column('assigned_to_user_id', sa.BigInteger, sa.ForeignKey('users.id'), nullable=True),
        sa.Column('workstation_name', sa.Text, nullable=True),
        sa.Column('status', sa.Text, nullable=False, server_default='pending'),
        sa.Column('assigned_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('viewed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('processing_started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('timeout_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('action_history', postgresql.JSONB, nullable=True),
        sa.Column('device_ip', sa.Text, nullable=True),
        sa.Column('device_user_agent', sa.Text, nullable=True),
        sa.Column('priority', sa.Integer, nullable=False, server_default='0'),
        sa.Column('version', sa.Integer, nullable=False, server_default='1'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_workstation_session_user', 'financial_workstation_sessions', ['assigned_to_user_id', 'status'])
    op.create_index('idx_workstation_session_invoice', 'financial_workstation_sessions', ['invoice_request_id'])
    op.create_index('idx_workstation_session_timeout', 'financial_workstation_sessions', ['timeout_at'])
    op.create_index('idx_workstation_session_tenant', 'financial_workstation_sessions', ['tenant_id'])

    # ── 7. invoice_audit_logs ──
    op.create_table(
        'invoice_audit_logs',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('event_type', sa.Text, nullable=False),
        sa.Column('actor_id', sa.BigInteger, nullable=True),
        sa.Column('resource_type', sa.Text, nullable=False),
        sa.Column('resource_id', sa.Text, nullable=False),
        sa.Column('action', sa.Text, nullable=False),
        sa.Column('changes', postgresql.JSONB, nullable=True),
        sa.Column('previous_hash', sa.Text, nullable=True),
        sa.Column('current_hash', sa.Text, nullable=False),
        sa.Column('minio_status', sa.Text, nullable=False, server_default='pending'),
        sa.Column('minio_object_key', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_inv_audit_tenant_event', 'invoice_audit_logs', ['tenant_id', 'event_type', 'created_at'])
    op.create_index('idx_inv_audit_resource', 'invoice_audit_logs', ['resource_type', 'resource_id'])
    op.create_index('idx_inv_audit_tenant', 'invoice_audit_logs', ['tenant_id'])

    # ── 8. 数据库触发器：invoice_records INSERT-only ──
    op.execute("""
        CREATE OR REPLACE FUNCTION _reject_invoice_record_update()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION 'InvoiceRecord is INSERT-only. Create a new version instead.';
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("""
        CREATE TRIGGER trg_invoice_records_no_update
        BEFORE UPDATE ON invoice_records
        FOR EACH ROW EXECUTE FUNCTION _reject_invoice_record_update();
    """)
    op.execute("""
        CREATE TRIGGER trg_invoice_records_no_delete
        BEFORE DELETE ON invoice_records
        FOR EACH ROW EXECUTE FUNCTION _reject_invoice_record_update();
    """)


def downgrade() -> None:
    # ── 删除触发器 ──
    op.execute("DROP TRIGGER IF EXISTS trg_invoice_records_no_delete ON invoice_records")
    op.execute("DROP TRIGGER IF EXISTS trg_invoice_records_no_update ON invoice_records")
    op.execute("DROP FUNCTION IF EXISTS _reject_invoice_record_update()")

    # ── 删除表（逆序） ──
    op.drop_table('invoice_audit_logs')
    op.drop_table('financial_workstation_sessions')
    op.drop_table('invoice_records')
    op.drop_table('invoice_requests')
    op.drop_table('invoice_templates')
    op.drop_table('invoice_platform_configs')
    op.drop_table('customer_invoice_headers')
