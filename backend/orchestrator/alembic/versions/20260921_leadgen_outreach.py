"""leadgen_outreach_chain

Revision ID: 20260921_leadgen_outreach
Revises: 20260921_ai_layer
Create Date: 2026-09-21

P2-P6 工位链（docs 最终设计 §三/§五/§六/§七/§八/§九）：
- lead_candidates：线索池共享表（owner=客户开发工位，触达/询盘只读）
  状态字段 outreach_status / inquiry_status 是三个工位间的唯一通信接口
- leadgen_runs：客户开发抓取运行记录（tenant+config_hash 唯一防重复 run）
- intel_demand_index：商情雷达空表留口子（第一版不接，填数据即生效）
- outreach_mailboxes / campaigns / messages：客户触达工位三表
  messages 按 tenant+resend_message_id 唯一防重复发送
- cust_inquiries.lead_id：线索转询盘关联（不合并表）
- tenant_subscriptions：订阅编码（未订阅工位 API 返回 404），种子 default=full_chain

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision: str = '20260921_leadgen_outreach'
down_revision: Union[str, None] = '20260921_ai_layer'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 线索池共享表 ──────────────────────────────────────────────────────
    op.create_table(
        'lead_candidates',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('place_id', sa.Text(), nullable=True),    # Google place_id，租户内唯一防重复抓取
        sa.Column('company_name', sa.Text(), nullable=False),
        sa.Column('country', sa.Text(), nullable=True),
        sa.Column('region', sa.Text(), nullable=True),      # 州/省
        sa.Column('city', sa.Text(), nullable=True),
        sa.Column('address', sa.Text(), nullable=True),
        sa.Column('phone', sa.Text(), nullable=True),
        sa.Column('website', sa.Text(), nullable=True),
        sa.Column('email', sa.Text(), nullable=True),
        sa.Column('industry', sa.Text(), nullable=True),
        sa.Column('source', sa.Text(), nullable=True),      # 抓取来源标识
        # Google 数据
        sa.Column('google_rating', sa.Numeric(3, 2), nullable=True),
        sa.Column('google_reviews', sa.Integer(), nullable=True),
        # AI 评分（不启用 AI 时走硬规则，仍写 fit_score）
        sa.Column('fit_score', sa.Integer(), nullable=True),        # 0-100
        sa.Column('fit_reasons', JSONB(), nullable=True),
        sa.Column('opening_line', sa.Text(), nullable=True),        # 开场白（模板或 AI 生成）
        # 工位间唯一通信接口（§3.4）
        sa.Column('outreach_status', sa.Text(), nullable=False, server_default='none'),
        # none/pending/sent/delivered/opened/replied/bounced（触达工位写）
        sa.Column('inquiry_status', sa.Text(), nullable=False, server_default='none'),
        # none/new/following/won/lost（询盘工位写）
        sa.Column('leadgen_run_id', sa.BigInteger(), nullable=True),
        sa.Column('raw', JSONB(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.Column('owner_id', sa.Text(), nullable=True),
        sa.Column('owner_scope', sa.Text(), nullable=False, server_default='private'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'place_id', name='uq_lead_candidates_place'),
    )
    op.create_index('idx_lead_candidates_outreach', 'lead_candidates',
                    ['tenant_id', 'outreach_status'])
    op.create_index('idx_lead_candidates_inquiry', 'lead_candidates',
                    ['tenant_id', 'inquiry_status'])
    op.create_index('idx_lead_candidates_score', 'lead_candidates',
                    ['tenant_id', 'fit_score'])

    # ── 客户开发运行记录 ───────────────────────────────────────────────────
    op.create_table(
        'leadgen_runs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('config', JSONB(), nullable=False),       # 地区/行业/ICP/数量
        sa.Column('config_hash', sa.Text(), nullable=False),
        sa.Column('status', sa.Text(), nullable=False, server_default='running'),
        # running | succeeded | failed
        sa.Column('leads_found', sa.Integer(), nullable=True),
        sa.Column('leads_kept', sa.Integer(), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'config_hash', name='uq_leadgen_runs_config'),
    )

    # ── 商情雷达空表（P6 口子：填数据即生效，接口已返回字段）───────────────
    op.create_table(
        'intel_demand_index',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('country', sa.Text(), nullable=True),
        sa.Column('region', sa.Text(), nullable=True),
        sa.Column('product_category', sa.Text(), nullable=True),
        sa.Column('hs_code', sa.Text(), nullable=True),
        sa.Column('demand_index', sa.Numeric(12, 4), nullable=True),
        sa.Column('blank_index', sa.Numeric(12, 4), nullable=True),
        sa.Column('month', sa.Text(), nullable=True),       # '2026-09'
        sa.Column('source', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_intel_demand_index_lookup', 'intel_demand_index',
                    ['tenant_id', 'country', 'product_category', 'month'])

    # ── 触达工位：发件邮箱（表支持多行，第一版只用一个）────────────────────
    op.create_table(
        'outreach_mailboxes',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('email', sa.Text(), nullable=False),
        sa.Column('name', sa.Text(), nullable=True),        # 显示名
        sa.Column('provider', sa.Text(), nullable=False, server_default='resend'),
        sa.Column('api_key', sa.Text(), nullable=True),
        sa.Column('is_default', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('daily_limit', sa.Integer(), nullable=True),   # 每日限额预留
        sa.Column('sent_today', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('last_sent_date', sa.Date(), nullable=True),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'email', name='uq_outreach_mailboxes_email'),
    )

    # ── 触达工位：活动（批量模板）──────────────────────────────────────────
    op.create_table(
        'outreach_campaigns',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('subject_template', sa.Text(), nullable=False),
        sa.Column('body_template', sa.Text(), nullable=False),
        sa.Column('mailbox_id', sa.BigInteger(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='draft'),
        # draft | sending | sent | paused
        sa.Column('total_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('sent_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('failed_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_by', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
    )

    # ── 触达工位：消息（收件人独立，一行一个收件人）────────────────────────
    op.create_table(
        'outreach_messages',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('campaign_id', sa.BigInteger(), nullable=True),
        sa.Column('lead_id', sa.BigInteger(), nullable=True),
        sa.Column('to_email', sa.Text(), nullable=False),
        sa.Column('to_name', sa.Text(), nullable=True),
        sa.Column('subject', sa.Text(), nullable=False),
        sa.Column('body_rendered', sa.Text(), nullable=False),
        sa.Column('resend_message_id', sa.Text(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='pending'),
        # pending | sending | sent | delivered | opened | replied | bounced | failed
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('opened_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('replied_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'resend_message_id', name='uq_outreach_messages_resend'),
    )
    op.create_index('idx_outreach_messages_campaign', 'outreach_messages',
                    ['tenant_id', 'campaign_id'])
    op.create_index('idx_outreach_messages_lead', 'outreach_messages',
                    ['tenant_id', 'lead_id'])

    # ── 线索转询盘关联（不合并表，lead_id 关联）────────────────────────────
    op.add_column('cust_inquiries', sa.Column('lead_id', sa.BigInteger(), nullable=True))
    op.create_index('idx_cust_inquiries_lead', 'cust_inquiries', ['lead_id'])

    # ── 订阅编码（§9.1；未订阅工位 API 返回 404）───────────────────────────
    op.create_table(
        'tenant_subscriptions',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('code', sa.Text(), nullable=False),
        # leadgen_starter | leadgen_pro | outreach_starter | outreach_pro | full_chain
        sa.Column('active', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'code', name='uq_tenant_subscriptions_code'),
    )
    # 开发租户默认全量订阅（生产按订单开通）
    op.execute(
        "INSERT INTO tenant_subscriptions (tenant_id, code) VALUES ('default', 'full_chain')"
    )


def downgrade() -> None:
    op.drop_table('tenant_subscriptions')
    op.drop_index('idx_cust_inquiries_lead', table_name='cust_inquiries')
    op.drop_column('cust_inquiries', 'lead_id')
    op.drop_index('idx_outreach_messages_lead', table_name='outreach_messages')
    op.drop_index('idx_outreach_messages_campaign', table_name='outreach_messages')
    op.drop_table('outreach_messages')
    op.drop_table('outreach_campaigns')
    op.drop_table('outreach_mailboxes')
    op.drop_index('idx_intel_demand_index_lookup', table_name='intel_demand_index')
    op.drop_table('intel_demand_index')
    op.drop_table('leadgen_runs')
    op.drop_index('idx_lead_candidates_score', table_name='lead_candidates')
    op.drop_index('idx_lead_candidates_inquiry', table_name='lead_candidates')
    op.drop_index('idx_lead_candidates_outreach', table_name='lead_candidates')
    op.drop_table('lead_candidates')
