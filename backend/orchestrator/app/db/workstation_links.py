# ─────────────────────────────────────────────────────────────────────────────
# 工作站互联 Schema 口子（Workstation Links）
# 依据 docs/WORKSTATION_DESIGN.md §5-§6 建立。
# 涵盖：报价工位 / 订单工位 / 外贸票据工位 的主表 + 跨工位关联表。
# 当前阶段仅建表（Phase 2），业务逻辑在后续工位开发时填充。
# ─────────────────────────────────────────────────────────────────────────────
from sqlalchemy import (
    Boolean,
    Column, BigInteger, Integer, Text, Numeric, DateTime, Date, Index, func,
    ForeignKey, CheckConstraint, text,
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
    # 税务档案快照（TAX-05）：选用档案 + 当时实际税率。
    # 档案只负责“填表”，本单实际算价仍用请求里的显式税率；tax_snapshot 用于历史复现。
    tax_archive_id = Column(BigInteger, nullable=True)
    tax_archive_code = Column(Text, nullable=True)
    tax_archive_name = Column(Text, nullable=True)
    tax_snapshot = Column(JSONB, nullable=True)
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
    # ── 202610170001：内部分解快照（成本/利润，签发时从算价引擎 internal 视图带来）──
    # 仅 internal 账号可见（API 出口按账号类型剔除）；NULL = 老数据无分解
    cost_breakdown = Column(JSONB, nullable=True)
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
    # ── 202610220001 订单金额构成（设计 §13.3）──
    # 四项金额 {goods_amount, freight_amount, insurance_amount, other_amount}；
    # 订单总额仍以 total_amount 为准，历史行为 NULL。
    amount_breakdown = Column(JSONB, nullable=True)
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

    # ── 202610220004 订单来源与确认（设计 OPTIMIZATION_PLAN_2026-10-22 §3.2/§5.1）──
    # 订单是一等公民：inquiry / direct 两种来源都能独立存在。
    #   source_type='inquiry' → 必须 inquiry_id（DB CHECK 兜底，见 __table_args__）；
    #   source_type='direct'  → inquiry_id 必须为空（线下单不许挂个假询盘凑数）。
    source_type = Column(Text, nullable=False, default="direct", server_default="direct")
    # 渠道：复用询盘渠道清单（email/whatsapp/alibaba/expo/website/phone/referral/other）。
    # 存量行为 NULL —— 前端展示「未知」，不伪造（设计 §4 回填说明）。
    source_channel = Column(Text, nullable=True)
    # 询盘来源（可空）：与 quote_id 各自独立，两个都可能为空（direct 单）、
    # 也可能都有（询盘→报价→订单）。ON DELETE SET NULL：询盘被硬删时订单保留。
    inquiry_id = Column(BigInteger, ForeignKey("cust_inquiries.id", ondelete="SET NULL"), nullable=True)
    # 确认三件套（§5.1）：confirmed_at/by 是审计痕迹，confirmed_source 区分触发方式。
    # 两者都是**人工**触发（D-17）：manual=人工点确认；deposit_receipt=人工登记定金到账联动。
    confirmed_at = Column(DateTime(timezone=True), nullable=True)
    confirmed_by = Column(Text, nullable=True)
    confirmed_source = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_orders_tenant", "tenant_id", "status"),
        Index("idx_orders_customer", "tenant_id", "customer_id"),
        # 来源筛选与「询盘详情页拉订单」都按 inquiry_id 走，必须有索引。
        Index("idx_orders_inquiry", "tenant_id", "inquiry_id"),
        # 设计 §3.3 R1（强制关联）：询盘转化单没有询盘 = 脏数据，DB 层直接拒。
        CheckConstraint(
            "source_type <> 'inquiry' OR inquiry_id IS NOT NULL",
            name="ck_orders_source_inquiry",
        ),
        CheckConstraint(
            "source_type IN ('inquiry','direct')",
            name="ck_orders_source_type",
        ),
        CheckConstraint(
            "confirmed_source IS NULL OR confirmed_source IN ('manual','deposit_receipt')",
            name="ck_orders_confirm_source",
        ),
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
    # 数据可见范围（§10.3）：生产有 owner_id/owner_scope（迁移 202609260002），
    # 模型此前漏建 ⇒ 空库快径缺列；worker 的单证查询按此过滤（2026-10-19 列级门禁发现）。
    owner_id = Column(Text, nullable=True)
    owner_scope = Column(Text, nullable=False, default="private", server_default="private")
    # 三层组织：本行归属的团队（写入时取创建者的团队；NULL = 未分组，保持原有可见性）
    team_id = Column(BigInteger, ForeignKey("teams.id", ondelete="SET NULL"), nullable=True)
    # 盖章开关（迁移 202610220002）：默认 TRUE ⇒ 历史行行为不变（自动带默认章）；
    # FALSE 时 render-data 不注入默认章（显式 custom.company_stamp 仍以单据为准）。
    with_seal = Column(Boolean(), nullable=False, default=True, server_default=text("true"))
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_trade_docs_tenant", "tenant_id", "doc_type", "status"),
        Index("idx_trade_docs_order", "tenant_id", "order_id"),
    )


class TradeDocRenderCheck(Base):
    """单证指纹对账结果（TODO(TODO:A8/A9)，迁移 `202610200002`）。

    每张单据**一行**（tenant+doc 唯一、覆盖写）：cron 每日扫描近期签发单据，
    把最近一次对账结论落库；列表端点 join 它显示「已变更」标识。
    不是业务事件流（只增不删）；完整卡片存 `result`，排查时不用重跑。
    """
    __tablename__ = "trade_doc_render_checks"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    trade_doc_id = Column(
        BigInteger, ForeignKey("trade_docs.id", ondelete="CASCADE"), nullable=False,
    )
    checked_at = Column(DateTime(timezone=True), nullable=False)
    matches = Column(Boolean, nullable=False)
    # matched | data_changed | version_drift | no_fingerprint |
    # current_unavailable | frozen_unavailable（内核原值）
    reason = Column(Text, nullable=False)
    render_version_drift = Column(Boolean, nullable=False, default=False, server_default="false")
    result = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index(
            "uq_trade_doc_render_checks_doc",
            "tenant_id", "trade_doc_id",
            unique=True,
        ),
    )


class TradeDocContentVersion(Base):
    """单证**内容**版本链（TODO(TODO:A1)，迁移 `202610200001`）。

    与 `file_objects.version` 的区别：后者是上传 PDF 的**文件**版本，
    本表是 `raw_payload`（sources + custom）的**内容**版本 —— 草稿期每次保存都留一版，
    issued 后锁死。签发时会把带 `_render` 指纹的终版也存一版。
    """
    __tablename__ = "trade_doc_content_versions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    trade_doc_id = Column(
        BigInteger, ForeignKey("trade_docs.id", ondelete="CASCADE"), nullable=False,
    )
    version_no = Column(Integer, nullable=False)
    raw_payload = Column(JSONB, nullable=False)
    # custom_update | refresh_sources | issue | restore
    change_source = Column(Text, nullable=False, default="custom_update", server_default="custom_update")
    actor_id = Column(Text, nullable=True)
    note = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index(
            "uq_trade_doc_content_versions_no",
            "tenant_id", "trade_doc_id", "version_no",
            unique=True,
        ),
        Index("idx_trade_doc_content_versions_doc", "tenant_id", "trade_doc_id"),
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


class TradeDocReceipt(Base):
    """收款登记（P1 · HARDENING_PLAN §E，迁移 202610170003）。

    每笔收款 vs 账期金额的差额与归因（UNCERTAIN #17 ③ 容差：
    max(5 美分等值, 0.1%)——差额 ≤ 容差自动核销 fx_rounding，否则 short_paid）。
    """
    __tablename__ = "trade_doc_receipts"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    trade_doc_id = Column(BigInteger, nullable=False)
    schedule_type = Column(Text, nullable=True)
    schedule_amount = Column(Numeric(20, 6), nullable=True)
    received_amount = Column(Numeric(20, 6), nullable=False)
    currency = Column(Text, nullable=False, default="USD")
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    bank_ref = Column(Text, nullable=True)
    diff = Column(Numeric(20, 6), nullable=True)
    diff_reason = Column(Text, nullable=True)
    fx_rate_used = Column(Numeric(20, 8), nullable=True)
    status = Column(Text, nullable=False, default="manual")
    notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_trade_doc_receipts_doc", "tenant_id", "trade_doc_id"),
    )


class TradeDocDocSetItem(Base):
    """单证清单项（P1 · HARDENING_PLAN §C + UNCERTAIN #17 ④，迁移 202610170003）。

    「这一次交易该出哪些单证」显式清单：`not_by_us`（对方出单）走回执登记
    （pending → received / waived），清单外的单证不允许被引用（P0 引用完整性）。
    """
    __tablename__ = "trade_doc_doc_set_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    trade_doc_id = Column(BigInteger, nullable=False)
    doc_type = Column(Text, nullable=False)
    role = Column(Text, nullable=False, default="required")
    issuer = Column(Text, nullable=False, default="ours")
    trigger_expr = Column(Text, nullable=True)
    evidence_required = Column(Boolean, nullable=False, default=False)
    status = Column(Text, nullable=False, default="pending")
    waived_reason = Column(Text, nullable=True)
    received_doc_id = Column(BigInteger, nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("uq_trade_doc_doc_set_item", "tenant_id", "trade_doc_id", "doc_type", unique=True),
    )


class TradeDocFact(Base):
    """单证事实（P1 · HARDENING_PLAN §A 事实层，迁移 202610200004）。

    「单证 payload 里的一坨字段」升级为**可追溯、有信任级、有不可改写属性**的事实：
    - `trust`：confirmed / unverified / inferred —— issued 单证不允许存在非 confirmed 事实；
    - `immutable`：基线事实（如 PI 的定金比例）派生单只能原值引用，改值 ⇒ FACT_IMMUTABLE；
    - `text_zh`/`text_en`：双语成对（一句一事实，中英同一条记录）；
    - `source` + `evidence_ref`：值从哪来（pi/上游单证/手工/AI 建议/推断），可回溯。

    金额额外落 `value_num`（Numeric）供容差比对；其余值落 `value_text`（规范化字符串）。
    同一定义域内同一 `fact_key` 只允许一行（唯一索引）。
    """
    __tablename__ = "trade_doc_facts"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    # 事实挂在具体单证上；单证删除时事实一并回收（事实不是对外凭证）
    trade_doc_id = Column(
        BigInteger, ForeignKey("trade_docs.id", ondelete="CASCADE"), nullable=False,
    )
    doc_type = Column(Text, nullable=False)
    doc_no = Column(Text, nullable=True)
    fact_key = Column(Text, nullable=False)
    value_text = Column(Text, nullable=True)
    value_num = Column(Numeric(20, 6), nullable=True)
    currency = Column(Text, nullable=True)
    text_zh = Column(Text, nullable=True)
    text_en = Column(Text, nullable=True)
    source = Column(Text, nullable=False, default="manual")
    trust = Column(Text, nullable=False, default="unverified")
    immutable = Column(Boolean, nullable=False, default=False)
    confirmed_by = Column(Text, nullable=True)
    confirmed_at = Column(DateTime(timezone=True), nullable=True)
    evidence_ref = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), nullable=False,
        server_default=func.now(), onupdate=func.now(),
    )

    __table_args__ = (
        Index("uq_trade_doc_fact", "tenant_id", "trade_doc_id", "fact_key", unique=True),
        Index("idx_trade_doc_facts_doc", "tenant_id", "trade_doc_id"),
        Index("idx_trade_doc_facts_key", "tenant_id", "fact_key"),
    )
