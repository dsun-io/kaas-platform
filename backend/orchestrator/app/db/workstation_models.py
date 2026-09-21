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
from app.db.base import Base


# ── 客户工位 ─────────────────────────────────────────────────────────────────

class CustCustomer(Base):
    """客户档案（§5.4）"""
    __tablename__ = 'cust_customers'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    company_name = Column(Text, nullable=False)
    country = Column(Text, nullable=True)
    address = Column(Text, nullable=True)
    default_port = Column(Text, nullable=True)
    credit_level = Column(Text, nullable=True)
    stage = Column(Text, nullable=False, server_default='lead')
    notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    owner_id = Column(Text, nullable=True)
    owner_scope = Column(Text, nullable=False, server_default='private')

    __table_args__ = (
        Index('idx_cust_customers_tenant_stage', 'tenant_id', 'stage'),
        Index('idx_cust_customers_tenant_country', 'tenant_id', 'country'),
    )


class CustContact(Base):
    """客户联系人（§5.4）"""
    __tablename__ = 'cust_contacts'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    customer_id = Column(BigInteger, ForeignKey('cust_customers.id', ondelete='CASCADE'), nullable=False)
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
    customer_id = Column(BigInteger, ForeignKey('cust_customers.id', ondelete='CASCADE'), nullable=False)
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
    customer_id = Column(BigInteger, ForeignKey('cust_customers.id', ondelete='CASCADE'), nullable=False)
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
