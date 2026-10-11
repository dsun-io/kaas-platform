# ─────────────────────────────────────────────────────────────────────────────
# 工作站互联 Schema 口子（Workstation Links）
# 依据 docs/WORKSTATION_DESIGN.md §5-§6 建立。
# 涵盖：报价工位 / 订单工位 / 外贸票据工位 的主表 + 跨工位关联表。
# 当前阶段仅建表（Phase 2），业务逻辑在后续工位开发时填充。
# ─────────────────────────────────────────────────────────────────────────────
from sqlalchemy import (
    Column, BigInteger, Integer, Text, Numeric, DateTime, Date, Index, func,
    ForeignKey, text,
)
from sqlalchemy.dialects.postgresql import JSONB
from app.db.base import Base


class QuoteOrder(Base):
    """报价工位 · 报价单头（预留口子）"""
    __tablename__ = "quote_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    quote_no = Column(Text, nullable=False, unique=True)
    # 业务客户外键（迁移 202610110009 由 TEXT 改成 BIGINT + 外键）：
    # 以前是自由文本、无约束，导致客户详情页聚合不出该客户的报价单。
    # ON DELETE SET NULL：客户行被硬删时报价单**保留**（历史凭证不能跟着消失），
    # 只是不再挂客户。customer_name 快照仍保留"开单当时的客户名"，改客户名不影响它。
    customer_id = Column(BigInteger, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    customer_name = Column(Text, nullable=True)
    # 询盘来源（迁移 202609270002 加正列）：一个询盘可以有多次报价（改价重报），
    # 因此是"询盘 1 : N 报价单"。可空 —— 历史报价单没有询盘来源属正常。
    inquiry_id = Column(BigInteger, nullable=True)
    status = Column(Text, nullable=False, default="draft")
    currency = Column(Text, nullable=False, default="USD")
    total_amount = Column(Numeric, nullable=True)
    valid_until = Column(DateTime(timezone=True), nullable=True)
    notes = Column(Text, nullable=True)
    # 汇率快照（§10.2）：迁移 20260921_business_foundation 已建列，
    # 但 ORM 之前漏了，导致 POST /quotes 构造对象时报
    # TypeError: 'fx_rate' is an invalid keyword argument for QuoteOrder。
    # 报价生成时锁定汇率，用于本币折算与后续订单继承。
    fx_rate = Column(Numeric(20, 8), nullable=True)
    fx_rate_date = Column(Date, nullable=True)
    # 贸易条款（202609260001 加正列）：报价谈定的条款必须能被单证继承，
    # 否则信用证审单时单证与合同不一致 →「不符点」
    incoterm = Column(Text, nullable=True)
    payment_terms = Column(Text, nullable=True)
    port_of_loading = Column(Text, nullable=True)
    port_of_destination = Column(Text, nullable=True)
    shipping_marks = Column(Text, nullable=True)
    country_of_origin = Column(Text, nullable=True)
    # ── 202610100003 订单/运输补字段 ──
    # 收货地（订单地区 ≠ 客户地区：经销商/中间商场景下两者常不同）
    destination_country = Column(Text, nullable=True)
    destination_region = Column(Text, nullable=True)
    carrier = Column(Text, nullable=True)  # 船公司
    freight_valid_from = Column(Date, nullable=True)  # 海运费有效期起
    freight_valid_to = Column(Date, nullable=True)  # 海运费有效期止
    created_by = Column(Text, nullable=True)
    # 数据可见范围（§10.3）：与 cust_inquiries / shipments / receivables 等表一致。
    # 迁移 202609260002 补建；API 的 scope_filter() 依赖这两列。
    owner_id = Column(Text, nullable=True)
    owner_scope = Column(Text, nullable=False, default="private", server_default="private")
    # 三层组织：本行归属的团队（写入时取创建者的团队；NULL = 未分组，保持原有可见性）
    team_id = Column(BigInteger, ForeignKey("teams.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_quote_orders_tenant", "tenant_id", "status"),
        Index("idx_quote_orders_customer", "tenant_id", "customer_id"),
    )


class QuoteOrderItem(Base):
    """报价工位 · 报价单行项（预留口子）"""
    __tablename__ = "quote_order_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    quote_order_id = Column(BigInteger, nullable=False)
    sku_id = Column(BigInteger, nullable=True)
    product_name = Column(Text, nullable=True)
    spec_snapshot = Column(JSONB, nullable=True)
    qty = Column(Numeric, nullable=False, default=1)
    qty_unit = Column(Text, nullable=True)
    unit_price = Column(Numeric, nullable=True)
    currency = Column(Text, nullable=False, default="USD")
    line_amount = Column(Numeric, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    # ── 202610100001：多产品逐行计算上下文 + 手动干预 ──
    # 行级报价政策覆盖（利润率/综合税费系数/成本口径等），空则继承报价单共享政策
    policy_override = Column(JSONB, nullable=True)
    # auto（公式自动）| manual（非标产品手动给价）| overridden（覆盖公式结果）
    price_source = Column(Text, nullable=False, default="auto", server_default="auto")
    cost_override = Column(Numeric(20, 6), nullable=True)
    price_override = Column(Numeric(20, 6), nullable=True)
    weight_override = Column(Numeric(20, 6), nullable=True)
    volume_override = Column(Numeric(20, 6), nullable=True)
    image_url = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_quote_order_items_quote", "tenant_id", "quote_order_id"),
    )


class QuoteOrderShipmentRef(Base):
    """关联表：报价单 ↔ 商情雷达货运记录（信号溯源）"""
    __tablename__ = "quote_order_shipment_refs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    quote_order_id = Column(BigInteger, nullable=False)
    shipment_id = Column(BigInteger, nullable=False)
    ref_type = Column(Text, nullable=False, default="buyer_signal")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index(
            "uq_quote_order_shipment_refs",
            "tenant_id", "quote_order_id", "ref_type", "shipment_id",
            unique=True,
        ),
    )


class Order(Base):
    """订单工位 · 销售订单头（预留口子）"""
    __tablename__ = "orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    order_no = Column(Text, nullable=False, unique=True)
    # 业务客户外键（迁移 202610110009 由 TEXT 改成 BIGINT + 外键），语义同 QuoteOrder
    customer_id = Column(BigInteger, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    quote_id = Column(BigInteger, ForeignKey("quote_orders.id", ondelete="SET NULL"), nullable=True)
    customer_name = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="pending")
    currency = Column(Text, nullable=False, default="USD")
    total_amount = Column(Numeric, nullable=True)
    order_date = Column(DateTime(timezone=True), nullable=True)
    delivery_date = Column(DateTime(timezone=True), nullable=True)
    notes = Column(Text, nullable=True)
    # 汇率快照（§10.2）：迁移已建列，ORM 之前漏了（与 QuoteOrder 同因）
    fx_rate = Column(Numeric(20, 8), nullable=True)
    fx_rate_date = Column(Date, nullable=True)
    # 贸易条款（202609260001 加正列）：与报价单同理由，单据需继承订单上的条款
    incoterm = Column(Text, nullable=True)
    payment_terms = Column(Text, nullable=True)
    port_of_loading = Column(Text, nullable=True)
    port_of_destination = Column(Text, nullable=True)
    shipping_marks = Column(Text, nullable=True)
    country_of_origin = Column(Text, nullable=True)
    # ── 202610100003 订单/运输补字段 ──
    # 收货地（订单地区 ≠ 客户地区：经销商/中间商场景下两者常不同）
    destination_country = Column(Text, nullable=True)
    destination_region = Column(Text, nullable=True)
    carrier = Column(Text, nullable=True)  # 船公司
    freight_valid_from = Column(Date, nullable=True)  # 海运费有效期起
    freight_valid_to = Column(Date, nullable=True)  # 海运费有效期止
    created_by = Column(Text, nullable=True)
    # 数据可见范围（§10.3）：与报价单同因，由迁移 202609260002 补建
    owner_id = Column(Text, nullable=True)
    owner_scope = Column(Text, nullable=False, default="private", server_default="private")
    # 三层组织：本行归属的团队（写入时取创建者的团队；NULL = 未分组，保持原有可见性）
    team_id = Column(BigInteger, ForeignKey("teams.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_orders_tenant", "tenant_id", "status"),
        Index("idx_orders_customer", "tenant_id", "customer_id"),
    )


class OrderItem(Base):
    """订单工位 · 订单行项（预留口子）"""
    __tablename__ = "order_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    order_id = Column(BigInteger, nullable=False)
    sku_id = Column(BigInteger, nullable=True)
    product_name = Column(Text, nullable=True)
    spec_snapshot = Column(JSONB, nullable=True)
    qty = Column(Numeric, nullable=False, default=1)
    qty_unit = Column(Text, nullable=True)
    unit_price = Column(Numeric, nullable=True)
    currency = Column(Text, nullable=False, default="USD")
    line_amount = Column(Numeric, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    # ── 202610100001：多产品逐行计算上下文 + 手动干预（与报价单行项同构）──
    policy_override = Column(JSONB, nullable=True)
    price_source = Column(Text, nullable=False, default="auto", server_default="auto")
    cost_override = Column(Numeric(20, 6), nullable=True)
    price_override = Column(Numeric(20, 6), nullable=True)
    weight_override = Column(Numeric(20, 6), nullable=True)
    volume_override = Column(Numeric(20, 6), nullable=True)
    image_url = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_order_items_order", "tenant_id", "order_id"),
    )


class OrderQuoteRef(Base):
    """【已退场·勿用】销售订单 ↔ 报价单（转化来源）。

    物理表已随迁移 `202610110014` 改名 `order_quote_refs_legacy`（只留档）。
    归属改由**列** `orders.quote_id` 表达，关系由触发器 `trg_orders_links`
    自动派生进 `entity_links` —— 这里保留 ORM 类只为历史迁移留证。
    """
    __tablename__ = "order_quote_refs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    order_id = Column(BigInteger, nullable=False)
    quote_order_id = Column(BigInteger, nullable=False)
    ref_type = Column(Text, nullable=False, default="converted_from")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index(
            "uq_order_quote_refs",
            "tenant_id", "order_id", "ref_type", "quote_order_id",
            unique=True,
        ),
    )


class OrderShipmentRef(Base):
    """关联表：销售订单 ↔ 商情雷达货运记录（物流依据）"""
    __tablename__ = "order_shipment_refs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    order_id = Column(BigInteger, nullable=False)
    shipment_id = Column(BigInteger, nullable=False)
    ref_type = Column(Text, nullable=False, default="actual_shipment")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index(
            "uq_order_shipment_refs",
            "tenant_id", "order_id", "ref_type", "shipment_id",
            unique=True,
        ),
    )


class TradeDoc(Base):
    """外贸票据工位 · 票据主表（预留口子）"""
    __tablename__ = "trade_docs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    doc_no = Column(Text, nullable=False, unique=True)
    doc_type = Column(Text, nullable=False)
    order_id = Column(BigInteger, nullable=True)
    # 业务客户外键（迁移 202610110009 由 TEXT 改成 BIGINT + 外键），语义同 QuoteOrder。
    # 注意：单证表**没有** customer_name 列 —— 买方名字冻结在
    # raw_payload.sources.{order|quote}.customer_name 快照里（开单当时的名字）。
    customer_id = Column(BigInteger, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    quote_id = Column(BigInteger, ForeignKey("quote_orders.id", ondelete="SET NULL"), nullable=True)
    status = Column(Text, nullable=False, default="draft")
    currency = Column(Text, nullable=False, default="USD")
    total_amount = Column(Numeric, nullable=True)
    issued_at = Column(DateTime(timezone=True), nullable=True)
    issued_by = Column(Text, nullable=True)
    raw_payload = Column(JSONB, nullable=True)
    # 三层组织：本行归属的团队（写入时取创建者的团队；NULL = 未分组，保持原有可见性）
    team_id = Column(BigInteger, ForeignKey("teams.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_trade_docs_tenant", "tenant_id", "doc_type", "status"),
        Index("idx_trade_docs_order", "tenant_id", "order_id"),
    )


class TradeDocItem(Base):
    """外贸票据工位 · 票据行项（预留口子）"""
    __tablename__ = "trade_doc_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    trade_doc_id = Column(BigInteger, nullable=False)
    order_item_id = Column(BigInteger, nullable=True)
    product_name = Column(Text, nullable=True)
    spec_snapshot = Column(JSONB, nullable=True)
    qty = Column(Numeric, nullable=False, default=1)
    qty_unit = Column(Text, nullable=True)
    unit_price = Column(Numeric, nullable=True)
    currency = Column(Text, nullable=False, default="USD")
    line_amount = Column(Numeric, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)    # ── 202609300001：产品段 / 方案价 / 来源（单证工位独立化）──
    group_no = Column(Integer, nullable=False, default=0, server_default=text("0"))
    # 多方案单价：{"o30000": {"unit_price": ..., "line_amount": ...}, ...}
    scheme_prices = Column(JSONB, nullable=True)
    # generated（规格轴展开/派生带入）| manual（自由行手填）
    source = Column(Text, nullable=False, default="manual", server_default="manual")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_trade_doc_items_doc", "tenant_id", "trade_doc_id"),
    )


class TradeDocOrderRef(Base):
    """【已退场·勿用】票据 ↔ 销售订单（票据来源）。

    物理表已随迁移 `202610110014` 改名 `trade_doc_order_refs_legacy`（只留档）。
    归属改由**列** `trade_docs.order_id` 表达，关系由触发器 `trg_trade_docs_links`
    自动派生进 `entity_links`。
    """
    __tablename__ = "trade_doc_order_refs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    trade_doc_id = Column(BigInteger, nullable=False)
    order_id = Column(BigInteger, nullable=False)
    ref_type = Column(Text, nullable=False, default="generated_from")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index(
            "uq_trade_doc_order_refs",
            "tenant_id", "trade_doc_id", "ref_type", "order_id",
            unique=True,
        ),
    )
