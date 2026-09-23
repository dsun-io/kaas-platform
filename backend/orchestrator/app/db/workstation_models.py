"""客户工位 + Phase 2.5 基础表 ORM 模型

与 app/db/workstation_links.py 互补：那边是报价/订单/单证工位口子（Phase 2），
这边是客户工位（cust_*）与通用基础表（fx_rates / doc_sequences / shipments /
payment_schedules / receivables / unit_conversions），外加最新迁移补的
trade_doc_quote_refs / trade_doc_inquiry_refs。

对应迁移：
- 20260919_customers_market_subs  → cust_* 客户工位
- 20260921_trade_doc_upstream_refs → trade_doc_quote_refs / trade_doc_inquiry_refs
- 20260921_business_foundation    → fx_rates / doc_sequences / shipments /
                                      payment_schedules / receivables / unit_conversions
"""
from sqlalchemy import (
    Column, BigInteger, Integer, Text, Boolean, Numeric,
    DateTime, Date, Index, func, ForeignKey,
)
from sqlalchemy.dialects.postgresql import JSONB
from app.db.base import Base


# ── 客户工位 ─────────────────────────────────────────────────────────────────
# 阶段2 客户表合并（2026-09-22）：CustCustomer（cust_customers）已并入 app.db.models.Customer，
# 客户档案以 customers 表为准；以下三张子表保持原名，指针已改指 customers.id。

class CustContact(Base):
    """客户联系人（§5.4）"""
    __tablename__ = 'cust_contacts'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    customer_id = Column(BigInteger, ForeignKey('customers.id', ondelete='CASCADE'), nullable=False)
    name = Column(Text, nullable=False)
    position = Column(Text, nullable=True)
    phone = Column(Text, nullable=True)
    email = Column(Text, nullable=True)
    whatsapp = Column(Text, nullable=True)
    wechat = Column(Text, nullable=True)
    is_primary = Column(Boolean, nullable=False, server_default='false')
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('idx_cust_contacts_customer', 'customer_id'),
    )


class CustInquiry(Base):
    """询盘（§10.1 状态机：open → quoted → won/lost，驱动客户 stage）"""
    __tablename__ = 'cust_inquiries'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    customer_id = Column(BigInteger, ForeignKey('customers.id', ondelete='CASCADE'), nullable=False)
    lead_id = Column(BigInteger, nullable=True)   # 线索池转化来源（最终设计 §7.1）
    channel = Column(Text, nullable=True)
    category_id = Column(BigInteger, nullable=True)
    product_name_raw = Column(Text, nullable=True)
    quantity = Column(Numeric, nullable=True)
    quantity_unit = Column(Text, nullable=True)
    application = Column(Text, nullable=True)
    status = Column(Text, nullable=False, server_default='open')
    notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    owner_id = Column(Text, nullable=True)
    owner_scope = Column(Text, nullable=False, server_default='private')

    __table_args__ = (
        Index('idx_cust_inquiries_customer', 'customer_id', 'status'),
        Index('idx_cust_inquiries_tenant_status', 'tenant_id', 'status'),
    )


class CustStageLog(Base):
    """客户阶段变更日志（§10.1 联动动作必须落此表）"""
    __tablename__ = 'cust_stage_log'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    customer_id = Column(BigInteger, ForeignKey('customers.id', ondelete='CASCADE'), nullable=False)
    from_stage = Column(Text, nullable=True)
    to_stage = Column(Text, nullable=False)
    changed_by = Column(Text, nullable=True)
    reason = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('idx_cust_stage_log_customer', 'customer_id'),
    )


# ── 单证上游关联（20260921_trade_doc_upstream_refs）──────────────────────────

class TradeDocQuoteRef(Base):
    __tablename__ = 'trade_doc_quote_refs'
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    trade_doc_id = Column(BigInteger, nullable=False)
    quote_order_id = Column(BigInteger, nullable=False)
    ref_type = Column(Text, nullable=False, server_default='generated_from')
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    __table_args__ = (
        Index('uq_trade_doc_quote_refs', 'tenant_id', 'trade_doc_id', 'ref_type', 'quote_order_id', unique=True),
    )


class TradeDocInquiryRef(Base):
    __tablename__ = 'trade_doc_inquiry_refs'
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    trade_doc_id = Column(BigInteger, nullable=False)
    inquiry_id = Column(BigInteger, nullable=False)
    ref_type = Column(Text, nullable=False, server_default='generated_from')
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    __table_args__ = (
        Index('uq_trade_doc_inquiry_refs', 'tenant_id', 'trade_doc_id', 'ref_type', 'inquiry_id', unique=True),
    )


# ── Phase 2.5 基础表（§10）──────────────────────────────────────────────────

class FxRate(Base):
    """汇率表（§10.2，每日抓取，失败沿用昨日标 is_stale）"""
    __tablename__ = 'fx_rates'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    base_currency = Column(Text, nullable=False)
    quote_currency = Column(Text, nullable=False)
    rate = Column(Numeric(20, 8), nullable=False)
    rate_date = Column(Date, nullable=False)
    source = Column(Text, nullable=True)
    is_stale = Column(Boolean, nullable=False, server_default='false')
    fetched_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index('idx_fx_rates_lookup', 'base_currency', 'quote_currency', 'rate_date', unique=True),
    )


class DocSequence(Base):
    """单据号序列（§10.7，PK 复合键，事务内 UPDATE...RETURNING 取号）"""
    __tablename__ = 'doc_sequences'

    tenant_id = Column(Text, nullable=False, primary_key=True)
    doc_type = Column(Text, nullable=False, primary_key=True)
    period = Column(Text, nullable=False, primary_key=True)
    last_seq = Column(Integer, nullable=False, server_default='0')


class Shipment(Base):
    """自有出运台账（§10.6，区别于 intel_shipments 海关情报）

    客户/货物关键字段做快照冗余，目标是查数据能清晰还原客户当时的具体情况。
    """
    __tablename__ = 'shipments'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    shipment_no = Column(Text, nullable=False, unique=True)
    order_id = Column(BigInteger, nullable=True)
    customer_id = Column(BigInteger, nullable=True)
    # 客户当时快照
    customer_name = Column(Text, nullable=True)
    consignee = Column(Text, nullable=True)
    notify_party = Column(Text, nullable=True)
    # 货物当时快照
    cargo_desc = Column(Text, nullable=True)
    cargo_qty = Column(Numeric, nullable=True)
    cargo_qty_unit = Column(Text, nullable=True)
    cargo_weight_kg = Column(Numeric, nullable=True)
    cargo_volume_cbm = Column(Numeric, nullable=True)
    # 物流信息
    pol = Column(Text, nullable=True)
    pod = Column(Text, nullable=True)
    pol_name = Column(Text, nullable=True)
    pod_name = Column(Text, nullable=True)
    vessel = Column(Text, nullable=True)
    voyage = Column(Text, nullable=True)
    container_no = Column(Text, nullable=True)
    so_no = Column(Text, nullable=True)
    booking_no = Column(Text, nullable=True)
    bl_no = Column(Text, nullable=True)
    bl_type = Column(Text, nullable=True)
    etd = Column(Date, nullable=True)
    eta = Column(Date, nullable=True)
    atd = Column(Date, nullable=True)
    ata = Column(Date, nullable=True)
    status = Column(Text, nullable=False, server_default='booking')
    freight_remark = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    owner_id = Column(Text, nullable=True)
    owner_scope = Column(Text, nullable=False, server_default='private')

    __table_args__ = (
        Index('idx_shipments_tenant_status', 'tenant_id', 'status'),
        Index('idx_shipments_order', 'tenant_id', 'order_id'),
    )


class PaymentSchedule(Base):
    """付款计划（§10.5：只记阶段，不做收付款执行）"""
    __tablename__ = 'payment_schedules'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    order_id = Column(BigInteger, nullable=True)
    trade_doc_id = Column(BigInteger, nullable=True)
    schedule_type = Column(Text, nullable=False)  # deposit | balance | full
    ratio = Column(Numeric(5, 4), nullable=True)
    amount = Column(Numeric(14, 2), nullable=True)
    currency = Column(Text, nullable=False, server_default='USD')
    due_date = Column(Date, nullable=True)
    actual_date = Column(Date, nullable=True)
    status = Column(Text, nullable=False, server_default='pending')  # pending | paid | overdue
    fx_rate = Column(Numeric(20, 8), nullable=True)
    exchange_gain_loss = Column(Numeric(14, 2), nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    owner_id = Column(Text, nullable=True)
    owner_scope = Column(Text, nullable=False, server_default='private')

    __table_args__ = (
        Index('idx_payment_schedules_order', 'tenant_id', 'order_id'),
    )


class Receivable(Base):
    """应收台账（§10.2：原币应收 + 锁定汇率折算本币 + 汇兑损益）"""
    __tablename__ = 'receivables'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    order_id = Column(BigInteger, nullable=False)
    currency = Column(Text, nullable=False, server_default='USD')
    total_amount = Column(Numeric(14, 2), nullable=False, server_default='0')
    fx_rate = Column(Numeric(20, 8), nullable=True)
    fx_rate_date = Column(Date, nullable=True)
    base_currency = Column(Text, nullable=False, server_default='CNY')
    base_amount = Column(Numeric(14, 2), nullable=True)
    received_amount = Column(Numeric(14, 2), nullable=False, server_default='0')
    exchange_gain_loss = Column(Numeric(14, 2), nullable=True)
    status = Column(Text, nullable=False, server_default='unpaid')  # unpaid | partial | paid
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    owner_id = Column(Text, nullable=True)
    owner_scope = Column(Text, nullable=False, server_default='private')

    __table_args__ = (
        Index('uq_receivables_order', 'tenant_id', 'order_id', unique=True),
    )


class UnitConversion(Base):
    """SKU 级单位换算（§10.8：1 from_unit = factor to_unit）"""
    __tablename__ = 'unit_conversions'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    sku_id = Column(BigInteger, nullable=False)
    from_unit = Column(Text, nullable=False)
    to_unit = Column(Text, nullable=False)
    factor = Column(Numeric(20, 8), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('uq_unit_conversions', 'tenant_id', 'sku_id', 'from_unit', 'to_unit', unique=True),
    )


# ── P1 AI 层（20260921_ai_layer）────────────────────────────────────────────

class AiProvider(Base):
    """客户自配 AI Provider（DS / Kimi / Zhipu），API Key 每租户独立"""
    __tablename__ = 'ai_providers'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    provider = Column(Text, nullable=False)   # deepseek | kimi | zhipu
    api_key = Column(Text, nullable=True)
    model = Column(Text, nullable=True)
    base_url = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, server_default='false')
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('uq_ai_providers_tenant_provider', 'tenant_id', 'provider', unique=True),
    )


class AiTaskBinding(Base):
    """任务绑定：每任务选 Provider/模型/是否启用；"不用 AI"= enabled false"""
    __tablename__ = 'ai_task_bindings'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    task_key = Column(Text, nullable=False)
    provider = Column(Text, nullable=True)
    model = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, server_default='false')
    config = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('uq_ai_task_bindings_tenant_task', 'tenant_id', 'task_key', unique=True),
    )


class AiUsage(Base):
    """AI 调用对账（铁律：每次调用必落一条，失败可退款核对）"""
    __tablename__ = 'ai_usage'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    task_key = Column(Text, nullable=False)
    provider = Column(Text, nullable=True)
    model = Column(Text, nullable=True)
    prompt_tokens = Column(Integer, nullable=True)
    completion_tokens = Column(Integer, nullable=True)
    cost_usd = Column(Numeric(12, 6), nullable=True)
    status = Column(Text, nullable=False, server_default='success')
    error = Column(Text, nullable=True)
    latency_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('idx_ai_usage_tenant_time', 'tenant_id', 'created_at'),
        Index('idx_ai_usage_tenant_task', 'tenant_id', 'task_key'),
    )


# ── P2-P6 工位链（20260921_leadgen_outreach）─────────────────────────────────

class LeadCandidate(Base):
    """线索池共享表（owner=客户开发工位；触达/询盘只读）。

    outreach_status / inquiry_status 是三个工位间的唯一通信接口（§3.4）。
    """
    __tablename__ = 'lead_candidates'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    place_id = Column(Text, nullable=True)
    company_name = Column(Text, nullable=False)
    country = Column(Text, nullable=True)
    region = Column(Text, nullable=True)
    city = Column(Text, nullable=True)
    address = Column(Text, nullable=True)
    phone = Column(Text, nullable=True)
    website = Column(Text, nullable=True)
    email = Column(Text, nullable=True)
    industry = Column(Text, nullable=True)
    source = Column(Text, nullable=True)
    google_rating = Column(Numeric(3, 2), nullable=True)
    google_reviews = Column(Integer, nullable=True)
    fit_score = Column(Integer, nullable=True)
    fit_reasons = Column(JSONB, nullable=True)
    opening_line = Column(Text, nullable=True)
    outreach_status = Column(Text, nullable=False, server_default='none')
    inquiry_status = Column(Text, nullable=False, server_default='none')
    leadgen_run_id = Column(BigInteger, nullable=True)
    raw = Column(JSONB, nullable=True)
    # ── 产品信息（Google Places 拿不到，须爬官网；采集阶段只写 shop_type）──
    shop_type = Column(Text, nullable=True)           # Google primary_type
    product_image_url = Column(Text, nullable=True)   # 爬官网 OG:image
    product_name = Column(Text, nullable=True)        # 当地叫法原文
    product_name_cn = Column(Text, nullable=True)     # 中文对照（AI/用户）
    spec_raw = Column(Text, nullable=True)            # 规格原文
    spec_normalized = Column(JSONB, nullable=True)    # 结构化规格（AI）
    link_url = Column(Text, nullable=True)            # 产品/店铺链接
    can_supply = Column(Boolean, nullable=True)       # 能否提供（用户编辑）
    supply_notes = Column(Text, nullable=True)        # 供货备注（用户编辑）
    crawl_status = Column(Text, nullable=True, server_default='pending')
    crawled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    owner_id = Column(Text, nullable=True)
    owner_scope = Column(Text, nullable=False, server_default='private')

    __table_args__ = (
        Index('uq_lead_candidates_place', 'tenant_id', 'place_id', unique=True),
        Index('idx_lead_candidates_outreach', 'tenant_id', 'outreach_status'),
        Index('idx_lead_candidates_inquiry', 'tenant_id', 'inquiry_status'),
        Index('idx_lead_candidates_score', 'tenant_id', 'fit_score'),
        Index('idx_lead_candidates_crawl', 'tenant_id', 'crawl_status'),
    )


class LeadgenRun(Base):
    """客户开发运行记录（tenant+config_hash 唯一防重复 run）"""
    __tablename__ = 'leadgen_runs'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    config = Column(JSONB, nullable=False)
    config_hash = Column(Text, nullable=False)
    status = Column(Text, nullable=False, server_default='running')
    leads_found = Column(Integer, nullable=True)
    leads_kept = Column(Integer, nullable=True)
    error = Column(Text, nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('uq_leadgen_runs_config', 'tenant_id', 'config_hash', unique=True),
    )


class IntelDemandIndex(Base):
    """商情雷达需求指数空表（P6 口子：填数据即生效）"""
    __tablename__ = 'intel_demand_index'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    country = Column(Text, nullable=True)
    region = Column(Text, nullable=True)
    product_category = Column(Text, nullable=True)
    hs_code = Column(Text, nullable=True)
    demand_index = Column(Numeric(12, 4), nullable=True)
    blank_index = Column(Numeric(12, 4), nullable=True)
    month = Column(Text, nullable=True)
    source = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('idx_intel_demand_index_lookup', 'tenant_id', 'country', 'product_category', 'month'),
    )


# ── 市场调研工位（20260922_research_workstation）─────────────────────────────
#
# 情报体系 = 进出口情报（宏观）+ 市场调研（微观）+ 地图源客户信息获取（源头）
# 市场调研定位 = 从「地图源」产出中挑选有价值的数据，再深入细化：
#   - 挑选：source_ref 指向 lead_candidates.id
#   - 细化：price_local / product_category / market_note / spec_normalized

class ResearchProduct(Base):
    """市场调研 · 产品（挑选 + 深化结果）"""
    __tablename__ = 'research_products'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    source_ref = Column(BigInteger, nullable=True)   # lead_candidates.id
    source = Column(Text, nullable=True)             # google_places/website_crawl/csv/manual
    # 产品
    product_name = Column(Text, nullable=True)
    product_name_cn = Column(Text, nullable=True)
    product_image_url = Column(Text, nullable=True)
    spec_raw = Column(Text, nullable=True)
    spec_normalized = Column(JSONB, nullable=True)
    product_category = Column(Text, nullable=True)
    # 市场位置
    country = Column(Text, nullable=True)
    region = Column(Text, nullable=True)
    city = Column(Text, nullable=True)
    # 店铺（冗余自地图源，便于本工位独立渲染）
    shop_name = Column(Text, nullable=True)
    shop_type = Column(Text, nullable=True)
    address = Column(Text, nullable=True)
    phone = Column(Text, nullable=True)
    email = Column(Text, nullable=True)
    website = Column(Text, nullable=True)
    link_url = Column(Text, nullable=True)
    # 深化字段
    price_local = Column(Numeric(12, 2), nullable=True)
    price_currency = Column(Text, nullable=True)
    market_note = Column(Text, nullable=True)
    can_supply = Column(Boolean, nullable=True)
    supply_notes = Column(Text, nullable=True)
    # 元数据
    research_status = Column(Text, nullable=False, server_default='draft')
    owner_id = Column(Text, nullable=True)
    owner_scope = Column(Text, nullable=False, server_default='private')
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False,
                        server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('uq_research_products_source', 'tenant_id', 'source_ref', unique=True),
        Index('idx_research_products_geo', 'tenant_id', 'country', 'city'),
        Index('idx_research_products_category', 'tenant_id', 'product_category'),
        Index('idx_research_products_supply', 'tenant_id', 'can_supply'),
    )


class ResearchRun(Base):
    """市场调研运行记录（tenant+config_hash 唯一，重复执行幂等）"""
    __tablename__ = 'research_runs'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    config = Column(JSONB, nullable=False)
    config_hash = Column(Text, nullable=False)
    status = Column(Text, nullable=False, server_default='running')
    leads_scanned = Column(Integer, nullable=True)
    products_found = Column(Integer, nullable=True)
    products_kept = Column(Integer, nullable=True)
    error = Column(Text, nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('uq_research_runs_config', 'tenant_id', 'config_hash', unique=True),
    )


class OutreachMailbox(Base):
    """发件邮箱（表支持多行，第一版只用 is_default 一行）"""
    __tablename__ = 'outreach_mailboxes'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    email = Column(Text, nullable=False)
    name = Column(Text, nullable=True)
    provider = Column(Text, nullable=False, server_default='resend')
    api_key = Column(Text, nullable=True)
    is_default = Column(Boolean, nullable=False, server_default='false')
    daily_limit = Column(Integer, nullable=True)
    sent_today = Column(Integer, nullable=False, server_default='0')
    last_sent_date = Column(Date, nullable=True)
    enabled = Column(Boolean, nullable=False, server_default='true')
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('uq_outreach_mailboxes_email', 'tenant_id', 'email', unique=True),
    )


class OutreachCampaign(Base):
    """触达活动（批量模板：主题+正文+变量占位）"""
    __tablename__ = 'outreach_campaigns'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    subject_template = Column(Text, nullable=False)
    body_template = Column(Text, nullable=False)
    mailbox_id = Column(BigInteger, nullable=True)
    status = Column(Text, nullable=False, server_default='draft')
    total_count = Column(Integer, nullable=False, server_default='0')
    sent_count = Column(Integer, nullable=False, server_default='0')
    failed_count = Column(Integer, nullable=False, server_default='0')
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class OutreachMessage(Base):
    """触达消息（收件人独立一行；tenant+resend_message_id 唯一防重复发送）"""
    __tablename__ = 'outreach_messages'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    campaign_id = Column(BigInteger, nullable=True)
    lead_id = Column(BigInteger, nullable=True)
    to_email = Column(Text, nullable=False)
    to_name = Column(Text, nullable=True)
    subject = Column(Text, nullable=False)
    body_rendered = Column(Text, nullable=False)
    resend_message_id = Column(Text, nullable=True)
    status = Column(Text, nullable=False, server_default='pending')
    error = Column(Text, nullable=True)
    sent_at = Column(DateTime(timezone=True), nullable=True)
    opened_at = Column(DateTime(timezone=True), nullable=True)
    replied_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('uq_outreach_messages_resend', 'tenant_id', 'resend_message_id', unique=True),
        Index('idx_outreach_messages_campaign', 'tenant_id', 'campaign_id'),
        Index('idx_outreach_messages_lead', 'tenant_id', 'lead_id'),
    )


class TenantSubscription(Base):
    """订阅编码（§9.1）：未订阅工位 API 返回 404"""
    __tablename__ = 'tenant_subscriptions'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    code = Column(Text, nullable=False)
    active = Column(Boolean, nullable=False, server_default='true')
    expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('uq_tenant_subscriptions_code', 'tenant_id', 'code', unique=True),
    )
