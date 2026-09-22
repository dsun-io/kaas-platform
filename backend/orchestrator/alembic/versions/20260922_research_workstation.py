"""research_workstation

Revision ID: 20260922_research_workstation
Revises: 20260921_leadgen_outreach
Create Date: 2026-09-22

情报体系三工位 + 产品信息补全（docs/WORKSTATION_DESIGN.md 变更档）：

情报体系 = 进出口情报（宏观）+ 市场调研（微观）+ 地图源客户信息获取（源头）

一、地图源客户信息获取工位（lead_candidates）补产品字段
    Google Places 只能拿到「店铺」信息（名称/地址/电话/评分/website/place_id/
    primary_type）。「产品」信息（图片/当地叫法/规格）必须爬官网获得，
    因此下列字段分为两个写入时机：
      - 采集阶段写：shop_type（Google primary_type）
      - 爬官网阶段写：product_image_url / product_name / spec_raw / link_url
      - AI 阶段写：product_name_cn（翻译）/ spec_normalized（结构化提取）
      - 用户编辑：can_supply / supply_notes

二、市场调研工位（新建）
    定位 = 从「地图源」产出中挑选有价值的数据，再深入细化。
    - research_products：挑选 + 深化结果（价格 / 品类归类 / 市场观察笔记）
      source_ref 指向 lead_candidates.id；UNIQUE(tenant_id, source_ref) 防重复挑选
    - research_runs：调研运行记录（tenant+config_hash 唯一，幂等）

三、订阅
    本期不激活订阅治理（保持 default=full_chain 现状），仅预留编码语义：
      intel_trade_starter / intel_research_starter / intel_full
    见 backend/worker/src/chain.py SUB_CODES。

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision: str = '20260922_research_workstation'
down_revision: Union[str, None] = '20260921_leadgen_outreach'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# 地图源工位新增的产品相关列（列名, 类型, 注释）
LEAD_PRODUCT_COLUMNS = [
    ('shop_type', sa.Text(), 'Google primary_type（采集阶段写入）'),
    ('product_image_url', sa.Text(), '产品图片（爬官网 OG:image）'),
    ('product_name', sa.Text(), '产品当地叫法原文（爬官网 title/h1）'),
    ('product_name_cn', sa.Text(), '中文对照（AI 翻译 / 用户编辑）'),
    ('spec_raw', sa.Text(), '规格原文（爬官网产品描述）'),
    ('spec_normalized', JSONB(), '结构化规格（AI 提取）'),
    ('link_url', sa.Text(), '产品/店铺链接（爬官网或 Google Maps）'),
    ('can_supply', sa.Boolean(), '能否提供（用户编辑，不由 AI 判定）'),
    ('supply_notes', sa.Text(), '供货备注（交期/起订量等，用户编辑）'),
    ('crawl_status', sa.Text(), '爬取状态：pending/success/failed/no_website'),
    ('crawled_at', sa.DateTime(timezone=True), '最近一次爬取时间'),
]


def upgrade() -> None:
    # ── 一、地图源工位：补产品字段 ────────────────────────────────────────
    for name, type_, comment in LEAD_PRODUCT_COLUMNS:
        kwargs = {'comment': comment}
        if name == 'crawl_status':
            kwargs['server_default'] = sa.text("'pending'")
        op.add_column('lead_candidates', sa.Column(name, type_, nullable=True, **kwargs))

    # 爬取状态按租户+状态筛选（找出待爬 / 失败可重试的）
    op.create_index('idx_lead_candidates_crawl', 'lead_candidates',
                    ['tenant_id', 'crawl_status'])

    # ── 二、市场调研工位：挑选 + 深化结果 ─────────────────────────────────
    op.create_table(
        'research_products',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        # 溯源：从地图源哪条线索挑选而来（手工录入时为 NULL）
        sa.Column('source_ref', sa.BigInteger(), nullable=True,
                  comment='lead_candidates.id（挑选来源）'),
        sa.Column('source', sa.Text(), nullable=True,
                  comment='google_places / website_crawl / csv / manual'),
        # 产品
        sa.Column('product_name', sa.Text(), nullable=True, comment='当地叫法原文'),
        sa.Column('product_name_cn', sa.Text(), nullable=True, comment='中文对照'),
        sa.Column('product_image_url', sa.Text(), nullable=True),
        sa.Column('spec_raw', sa.Text(), nullable=True, comment='规格原文'),
        sa.Column('spec_normalized', JSONB(), nullable=True, comment='结构化规格'),
        sa.Column('product_category', sa.Text(), nullable=True,
                  comment='品类归类（深化字段）'),
        # 市场位置
        sa.Column('country', sa.Text(), nullable=True),
        sa.Column('region', sa.Text(), nullable=True),
        sa.Column('city', sa.Text(), nullable=True),
        # 店铺（冗余自地图源，便于本工位独立渲染）
        sa.Column('shop_name', sa.Text(), nullable=True),
        sa.Column('shop_type', sa.Text(), nullable=True),
        sa.Column('address', sa.Text(), nullable=True),
        sa.Column('phone', sa.Text(), nullable=True),
        sa.Column('email', sa.Text(), nullable=True),
        sa.Column('website', sa.Text(), nullable=True),
        sa.Column('link_url', sa.Text(), nullable=True),
        # 深化字段
        sa.Column('price_local', sa.Numeric(12, 2), nullable=True,
                  comment='当地零售价'),
        sa.Column('price_currency', sa.Text(), nullable=True),
        sa.Column('market_note', sa.Text(), nullable=True, comment='市场观察笔记'),
        sa.Column('can_supply', sa.Boolean(), nullable=True,
                  comment='能否提供（用户编辑）'),
        sa.Column('supply_notes', sa.Text(), nullable=True),
        # 元数据
        sa.Column('research_status', sa.Text(), nullable=False,
                  server_default='draft', comment='draft / verified'),
        sa.Column('owner_id', sa.Text(), nullable=True),
        sa.Column('owner_scope', sa.Text(), nullable=False, server_default='private'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        # 同一条线索不允许重复挑选（NULL 可重复 = 支持多条手工录入）
        sa.UniqueConstraint('tenant_id', 'source_ref', name='uq_research_products_source'),
    )
    op.create_index('idx_research_products_geo', 'research_products',
                    ['tenant_id', 'country', 'city'])
    op.create_index('idx_research_products_category', 'research_products',
                    ['tenant_id', 'product_category'])
    op.create_index('idx_research_products_supply', 'research_products',
                    ['tenant_id', 'can_supply'])

    # ── 市场调研运行记录（幂等 + 审计）─────────────────────────────────────
    op.create_table(
        'research_runs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('config', JSONB(), nullable=False,
                  comment='挑选/爬取条件（国家/城市/品类/线索 id 列表）'),
        sa.Column('config_hash', sa.Text(), nullable=False),
        sa.Column('status', sa.Text(), nullable=False, server_default='running',
                  comment='running / succeeded / failed'),
        sa.Column('leads_scanned', sa.Integer(), nullable=True),
        sa.Column('products_found', sa.Integer(), nullable=True),
        sa.Column('products_kept', sa.Integer(), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'config_hash', name='uq_research_runs_config'),
    )


def downgrade() -> None:
    op.drop_table('research_runs')
    op.drop_index('idx_research_products_supply', table_name='research_products')
    op.drop_index('idx_research_products_category', table_name='research_products')
    op.drop_index('idx_research_products_geo', table_name='research_products')
    op.drop_table('research_products')
    op.drop_index('idx_lead_candidates_crawl', table_name='lead_candidates')
    for name, _type, _comment in reversed(LEAD_PRODUCT_COLUMNS):
        op.drop_column('lead_candidates', name)
