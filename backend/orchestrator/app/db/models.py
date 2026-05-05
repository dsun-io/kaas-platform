"""
Kaas v2 · SQLAlchemy ORM 模型
────────────────────────────
INT-R3: 平台规格与客户私有数据分离。
AUTH-WX-R1: 双账号类型 + 微信 ClawBot 接入底座。
"""
from sqlalchemy import (
    Column,
    BigInteger,
    Integer,
    Text,
    Boolean,
    Numeric,
    DateTime,
    Index,
    func,
    String,
    Float,
    ForeignKey,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID, ARRAY
from app.db.base import Base


class ProductSpec(Base):
    """平台通用规格表（INT-R3 §1.1）— 存规格不存价格"""
    __tablename__ = "product_specs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    product_category = Column(Text, nullable=False)
    product_type = Column(Text, nullable=True)
    wire_diameter = Column(Text, nullable=True)
    height = Column(Float, nullable=True)
    mesh_width = Column(Float, nullable=True)
    mesh_spec = Column(Text, nullable=True)
    roll_length = Column(Float, nullable=True)
    bundle_size = Column(Integer, nullable=True)
    weight_kg = Column(Float, nullable=True)
    spec_hash = Column(Text, nullable=False, unique=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_product_specs_category", "product_category", "product_type"),
    )


class CustomerCostItem(Base):
    """客户私有成本价（INT-R3 §1.2）— INSERT-only，不删历史"""
    __tablename__ = "customer_cost_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    customer_id = Column(Text, nullable=False)
    product_category = Column(Text, nullable=False)
    product_spec_id = Column(BigInteger, nullable=True)
    product_spec_json = Column(JSONB, nullable=True)
    spec_hash = Column(Text, nullable=False)
    cost_type = Column(Text, nullable=False)  # cost_per_kg / cost_per_sqm / cost_per_roll / cost_per_bundle / fixed
    amount = Column(Float, nullable=False)
    currency = Column(Text, nullable=False, default="CNY")
    unit = Column(Text, nullable=False)
    effective_from = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    effective_to = Column(DateTime(timezone=True), nullable=True)
    status = Column(Text, nullable=False, default="active")
    source = Column(Text, nullable=False, default="manual")
    notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_cost_items_lookup", "tenant_id", "customer_id", "spec_hash"),
    )


class CustomerSalePriceItem(Base):
    """客户私有销售价覆盖（INT-R3 §1.4）"""
    __tablename__ = "customer_sale_price_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    customer_id = Column(Text, nullable=False)
    product_category = Column(Text, nullable=False)
    product_spec_id = Column(BigInteger, nullable=True)
    product_spec_json = Column(JSONB, nullable=True)
    spec_hash = Column(Text, nullable=False)
    sale_price_type = Column(Text, nullable=False)  # sale_per_roll / sale_per_bundle / sale_per_piece / fixed
    amount = Column(Float, nullable=False)
    currency = Column(Text, nullable=False, default="CNY")
    unit = Column(Text, nullable=False)
    min_quantity = Column(Integer, nullable=True)
    effective_from = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    effective_to = Column(DateTime(timezone=True), nullable=True)
    status = Column(Text, nullable=False, default="active")
    source = Column(Text, nullable=False, default="manual")
    notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_sale_price_lookup", "tenant_id", "customer_id", "spec_hash"),
    )


class CustomerPricingProfile(Base):
    """客户私有报价策略（INT-R3 §1.3）"""
    __tablename__ = "customer_pricing_profiles"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    customer_id = Column(Text, nullable=False)
    product_category = Column(Text, nullable=False)
    profile_name = Column(Text, nullable=False, default="default")
    low_margin_rate = Column(Float, nullable=False)
    standard_margin_rate = Column(Float, nullable=False)
    high_margin_rate = Column(Float, nullable=False)
    tax_rate = Column(Float, nullable=False, default=0.0)
    effective_from = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    effective_to = Column(DateTime(timezone=True), nullable=True)
    status = Column(Text, nullable=False, default="active")
    source = Column(Text, nullable=False, default="manual")
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_pricing_profile_lookup", "tenant_id", "customer_id", "product_category"),
    )


class CustomerFreightRate(Base):
    """客户私有运费表（INT-R3 §1.5）"""
    __tablename__ = "customer_freight_rates"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    customer_id = Column(Text, nullable=False)
    carrier = Column(Text, nullable=False)
    province = Column(Text, nullable=False)
    formula_type = Column(Text, nullable=False)  # base_plus_weight / per_kg / fixed
    base_fee = Column(Float, nullable=True)
    threshold_kg = Column(Float, nullable=True)
    per_kg_after_threshold = Column(Float, nullable=True)
    min_weight_kg = Column(Float, nullable=True)
    fixed_fee = Column(Float, nullable=True)
    effective_from = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    effective_to = Column(DateTime(timezone=True), nullable=True)
    status = Column(Text, nullable=False, default="active")
    source = Column(Text, nullable=False, default="manual")
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_freight_lookup", "tenant_id", "customer_id", "province"),
    )


class Event(Base):
    """
    L0 原始事件流（飞轮唯一入口 · 永久归档 · 铁律5 · §3.7.1）
    id: BIGSERIAL PK, INSERT-only, 禁止 UPDATE/DELETE
    """
    __tablename__ = "events"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    schema_version = Column(Integer, nullable=False, default=1)
    tenant_id = Column(Text, nullable=False)
    event_type = Column(Text, nullable=False)
    event_source = Column(Text, nullable=False)
    actor_id = Column(Text, nullable=True)
    session_id = Column(Text, nullable=True)
    payload = Column(JSONB, nullable=False)
    trace_id = Column(Text, nullable=True)
    sampled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class EventsArchiveLog(Base):
    """
    L0 事件归档记录表 (§3.7.13)
    """
    __tablename__ = "events_archive_log"

    id = Column(UUID(as_uuid=True), primary_key=True, default=func.gen_random_uuid())
    tenant_id = Column(String(32), nullable=False)
    month = Column(String(7), nullable=False)
    minio_path = Column(String(255), nullable=False)
    status = Column(String(20), nullable=False)
    archived_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class Quotation(Base):
    """
    L4 报价事实表（永远 INSERT，不 UPDATE · 铁律5）
    """
    __tablename__ = "quotations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    schema_version = Column(Integer, nullable=False, default=1)
    customer_id = Column(Text, nullable=False)
    product_category = Column(Text, nullable=False)
    product_spec = Column(JSONB, nullable=False)
    spec_hash = Column(Text, nullable=False)
    unit_price = Column(Numeric(10, 4), nullable=True)
    currency = Column(Text, nullable=False, default="CNY")
    unit = Column(Text, nullable=False)
    discount = Column(Numeric(5, 4), nullable=True)
    min_quantity = Column(Integer, nullable=True)
    effective_from = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    source = Column(Text, nullable=False)
    notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index(
            "idx_quotations_lookup",
            "customer_id",
            "product_category",
            "spec_hash",
            effective_from.desc(),
        ),
    )


class CustomerCapability(Base):
    """
    客户支持的生产规格
    """
    __tablename__ = "customer_capabilities"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    schema_version = Column(Integer, nullable=False, default=1)
    customer_id = Column(Text, nullable=False)
    customer_name = Column(Text, nullable=False)
    product_category = Column(Text, nullable=False)
    spec_constraints = Column(JSONB, nullable=False)
    notes = Column(Text, nullable=True)
    effective_from = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_capabilities_lookup", "customer_id", "product_category"),
    )


class TextKnowledge(Base):
    """
    自包含文本知识表 — 不依赖 FastGPT 的知识存储。

    § 去 FastGPT 架构:
      - FAQ / 话术模板 / 产品描述 / 售后说明等文本知识
      - 所有文本知识自有 DB 存储，全文搜索自包含
      - 不依赖 FastGPT / 外部向量库
    """
    __tablename__ = "text_knowledge"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    customer_id = Column(Text, nullable=True)

    scope = Column(Text, nullable=False, default="tenant")          # global / tenant / customer
    product_category = Column(Text, nullable=True)

    knowledge_type = Column(Text, nullable=False)                   # faq / installation / after_sale / logistics / script_template / product_desc / glossary / synonym / sales_script / risk_notice
    title = Column(Text, nullable=False)
    content = Column(Text, nullable=False)

    tags = Column(ARRAY(Text), nullable=True)                        # TEXT[] — 使用 && 操作符检索
    keywords = Column(ARRAY(Text), nullable=True)                    # TEXT[] — 使用 && 操作符检索

    source = Column(Text, nullable=False, default="manual")         # manual / learned / imported / system
    status = Column(Text, nullable=False, default="active")         # active / deprecated / disabled

    confidence = Column(Numeric(5, 4), nullable=True)
    evidence_count = Column(Integer, nullable=False, default=0)

    review_status = Column(Text, nullable=False, default="auto")    # auto / pending_review / approved / rejected

    usage_count = Column(Integer, nullable=False, default=0)
    last_used_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_tk_tenant_type", "tenant_id", "knowledge_type", "status"),
        Index("idx_tk_customer", "tenant_id", "customer_id", "status"),
        Index("idx_tk_scope", "scope", "status"),
        Index("idx_tk_product_category", "tenant_id", "product_category", "status"),
    )


# ═══════════════════════════════════════════════════════════════
# AUTH-WX-R1: 账号与客户绑定 (§1-3)
# ═══════════════════════════════════════════════════════════════

class User(Base):
    """用户账号表 — internal / customer 双类型"""
    __tablename__ = "users"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    email = Column(Text, nullable=False, unique=True)
    password_hash = Column(Text, nullable=False)
    display_name = Column(Text, nullable=False)
    account_type = Column(Text, nullable=False)  # 'internal' | 'customer'
    role = Column(Text, nullable=False, default="user")  # 'system_admin' | 'admin' | 'owner' | 'user'
    plan = Column(Text, nullable=False, default="free")  # 'free' | 'pro' | 'enterprise' | 'internal'
    status = Column(Text, nullable=False, default="active")  # active | disabled
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_users_email", "email"),
        Index("idx_users_account_type", "account_type"),
    )


class Customer(Base):
    """客户表"""
    __tablename__ = "customers"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    code = Column(Text, nullable=True, unique=True)  # 兼容现有 Text customer_id (如 "lianjia")
    name = Column(Text, nullable=False)
    plan = Column(Text, nullable=False, default="free")  # 'free' | 'pro' | 'enterprise' | 'internal'
    status = Column(Text, nullable=False, default="active")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_customers_tenant", "tenant_id"),
        Index("idx_customers_code", "code"),
    )


class UserCustomer(Base):
    """用户-客户绑定表"""
    __tablename__ = "user_customers"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    customer_id = Column(BigInteger, ForeignKey("customers.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_user_customers_user", "user_id"),
        Index("idx_user_customers_customer", "customer_id"),
    )


# ═══════════════════════════════════════════════════════════════
# AUTH-WX-R1: 微信 ClawBot 接入底座 (§7-8)
# ═══════════════════════════════════════════════════════════════

class WechatBotAccount(Base):
    """微信机器人账号"""
    __tablename__ = "wechat_bot_accounts"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    customer_id = Column(BigInteger, ForeignKey("customers.id"), nullable=False)
    tenant_id = Column(Text, nullable=False)
    bot_name = Column(Text, nullable=False)
    bot_type = Column(Text, nullable=False, default="clawbot")
    status = Column(Text, nullable=False, default="active")  # active | paused | revoked | error
    bot_token_encrypted = Column(Text, nullable=True)
    last_get_updates_buf = Column(Text, nullable=True)  # JSON string
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_wx_bot_customer", "customer_id"),
        Index("idx_wx_bot_tenant", "tenant_id"),
        Index("idx_wx_bot_status", "status"),
    )


class WechatConversation(Base):
    """微信会话（按 from_user_id + bot 维度）"""
    __tablename__ = "wechat_conversations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    customer_id = Column(BigInteger, ForeignKey("customers.id"), nullable=False)
    tenant_id = Column(Text, nullable=False)
    bot_account_id = Column(BigInteger, ForeignKey("wechat_bot_accounts.id"), nullable=False)
    wechat_session_id = Column(Text, nullable=False)
    from_user_id = Column(Text, nullable=False)
    last_context_token_encrypted = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="active")
    last_message_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_wx_conv_customer", "customer_id"),
        Index("idx_wx_conv_bot_account", "bot_account_id"),
        Index("idx_wx_conv_session", "wechat_session_id"),
        Index("idx_wx_conv_from_user", "bot_account_id", "from_user_id"),
    )


class ChannelLink(Base):
    """渠道链接（微信接入绑定/二维码场景）"""
    __tablename__ = "channel_links"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    customer_id = Column(BigInteger, ForeignKey("customers.id"), nullable=False)
    tenant_id = Column(Text, nullable=False)
    channel = Column(Text, nullable=False)  # wechat_clawbot | wechat_h5
    name = Column(Text, nullable=True)
    scenario = Column(Text, nullable=True)
    link_token = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_channel_link_customer", "customer_id"),
        Index("idx_channel_link_token", "link_token"),
    )


# ═══════════════════════════════════════════════════════════════
# AUTH-WX-R1: 对话编排 & 日志 (§10, §14)
# ═══════════════════════════════════════════════════════════════

class Conversation(Base):
    """对话记录"""
    __tablename__ = "conversations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    customer_id = Column(BigInteger, ForeignKey("customers.id"), nullable=False)
    tenant_id = Column(Text, nullable=False)
    channel = Column(Text, nullable=False)  # wechat_clawbot | wechat_h5 | web
    status = Column(Text, nullable=False, default="active")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_conv_customer", "customer_id"),
        Index("idx_conv_channel", "channel"),
    )


class ConversationMessage(Base):
    """对话消息"""
    __tablename__ = "conversation_messages"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    conversation_id = Column(BigInteger, ForeignKey("conversations.id"), nullable=False)
    role = Column(Text, nullable=False)  # user | assistant | system
    raw_content = Column(Text, nullable=True)
    normalized_content = Column(Text, nullable=True)
    intent = Column(Text, nullable=True)
    product_category = Column(Text, nullable=True)
    extracted_params_json = Column(JSONB, nullable=True)
    quote_status = Column(Text, nullable=True)
    latency_ms = Column(Integer, nullable=True)
    error_code = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_conv_msg_conv", "conversation_id"),
    )


class UsageEvent(Base):
    """用量事件"""
    __tablename__ = "usage_events"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    customer_id = Column(BigInteger, ForeignKey("customers.id"), nullable=True)
    tenant_id = Column(Text, nullable=False)
    channel = Column(Text, nullable=False)
    event_type = Column(Text, nullable=False)
    success = Column(Boolean, nullable=False, default=True)
    error_code = Column(Text, nullable=True)
    metadata_json = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_usage_events_customer", "customer_id"),
        Index("idx_usage_events_type", "event_type"),
    )


class WechatMessageEvent(Base):
    """微信消息事件日志"""
    __tablename__ = "wechat_message_events"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    bot_account_id = Column(BigInteger, ForeignKey("wechat_bot_accounts.id"), nullable=False)
    wechat_session_id = Column(Text, nullable=True)
    from_user_id = Column(Text, nullable=True)
    message_id = Column(Text, nullable=True)
    direction = Column(Text, nullable=False)  # inbound | outbound
    message_type = Column(Text, nullable=False, default="text")  # text | voice | image
    status = Column(Text, nullable=False, default="received")
    error_code = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_wx_msg_event_bot", "bot_account_id"),
        Index("idx_wx_msg_event_session", "wechat_session_id"),
    )
