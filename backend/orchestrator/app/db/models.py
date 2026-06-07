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
    UniqueConstraint,
    CheckConstraint,
    Date,
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
    tenant_id = Column(Text, nullable=False, index=True)
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

    # Spec system v2 references (nullable for backward compatibility)
    sku_id = Column(BigInteger, ForeignKey("product_skus.id"), nullable=True)
    price_id = Column(BigInteger, ForeignKey("product_sku_prices.id"), nullable=True)
    schema_version_v2 = Column(Integer, nullable=True)

    __table_args__ = (
        Index(
            "idx_quotations_lookup",
            "customer_id",
            "product_category",
            "spec_hash",
            effective_from.desc(),
        ),
        Index("idx_quotations_tenant", "tenant_id", "customer_id"),
    )


class CustomerCapability(Base):
    """
    客户支持的生产规格
    """
    __tablename__ = "customer_capabilities"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    schema_version = Column(Integer, nullable=False, default=1)
    tenant_id = Column(Text, nullable=False, index=True)
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
        Index("idx_capabilities_tenant", "tenant_id", "customer_id"),
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
    is_tenant_admin = Column(Boolean, nullable=False, default=False)
    status = Column(Text, nullable=False, default="active")  # active | disabled
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    @property
    def effective_role(self) -> str:
        """应用层角色映射：旧角色 → 新三层角色体系。

        映射规则:
        - system_admin → system_admin
        - admin → system_admin (合并)
        - owner → customer_owner (迁移)
        - customer_owner → customer_owner
        - user → customer_member (预留)
        - customer_member → customer_member
        """
        ROLE_MAP = {
            "system_admin": "system_admin",
            "admin": "system_admin",
            "owner": "customer_owner",
            "customer_owner": "customer_owner",
            "user": "customer_member",
            "customer_member": "customer_member",
        }
        return ROLE_MAP.get(self.role, "customer_member")

    __table_args__ = (
        Index("idx_users_email", "email"),
        Index("idx_users_account_type", "account_type"),
    )


class UserRole(Base):
    """用户角色扩展表 — 为 L3 细粒度权限预留。"""
    __tablename__ = "user_roles"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    tenant_id = Column(Text, nullable=False)
    role = Column(Text, nullable=False)  # 'customer_owner' | 'customer_member'
    permissions = Column(JSONB, nullable=True)  # 细粒度权限（L3 时使用）
    granted_by = Column(BigInteger, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("idx_user_roles_user_tenant", "user_id", "tenant_id"),
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


# ═══════════════════════════════════════════════════════════════
# SPEC SYSTEM: 类目-属性-SKU-Price 可扩展规格体系
# ═══════════════════════════════════════════════════════════════


class ProductCategory(Base):
    """品类树"""
    __tablename__ = "product_categories"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(Text, nullable=False, unique=True)
    name = Column(Text, nullable=False)
    parent_id = Column(BigInteger, ForeignKey("product_categories.id", ondelete="RESTRICT"), nullable=True)
    path = Column(Text, nullable=False)
    level = Column(Integer, nullable=False, default=1)
    industry_code = Column(Text, nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)
    is_leaf = Column(Boolean, nullable=False, default=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_pc_path", "path"),
        Index("idx_pc_industry", "industry_code"),
        Index("idx_pc_parent", "parent_id"),
    )


class UnitGroup(Base):
    """单位族字典"""
    __tablename__ = "unit_groups"

    code = Column(Text, primary_key=True)
    name = Column(Text, nullable=False)
    base_unit = Column(Text, nullable=False)


class Unit(Base):
    """单位字典"""
    __tablename__ = "units"

    code = Column(Text, primary_key=True)
    label = Column(Text, nullable=False)
    unit_group = Column(Text, ForeignKey("unit_groups.code"), nullable=False)
    to_base_factor = Column(Numeric(20, 10), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)


class PriceUnit(Base):
    """计价单位字典"""
    __tablename__ = "price_units"

    code = Column(Text, primary_key=True)
    label = Column(Text, nullable=False)
    currency = Column(Text, nullable=False)
    unit = Column(Text, nullable=False)
    unit_group = Column(Text, nullable=False)
    applicable_categories = Column(JSONB, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)


class SpecAttribute(Base):
    """属性库"""
    __tablename__ = "spec_attributes"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    aliases = Column(JSONB, nullable=False, default=[])
    group_code = Column(Text, nullable=False)  # identity/variant/spec/pricing/temporal
    data_type = Column(Text, nullable=False)  # enum/multi_enum/number/text/bool
    unit = Column(Text, nullable=True)
    unit_group = Column(Text, nullable=True)
    number_min = Column(Numeric, nullable=True)
    number_max = Column(Numeric, nullable=True)
    number_step = Column(Numeric, nullable=True)
    description = Column(Text, nullable=True)
    scope = Column(Text, nullable=False, default="private")  # public/private/proposal
    tenant_id = Column(Text, nullable=True)
    source = Column(Text, nullable=False, default="tenant")
    status = Column(Text, nullable=False, default="active")
    promoted_from = Column(BigInteger, nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_sa_scope_status", "scope", "status"),
        Index("idx_sa_group", "group_code"),
    )


class SpecAttributeValue(Base):
    """属性枚举值库"""
    __tablename__ = "spec_attribute_values"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    attribute_id = Column(BigInteger, ForeignKey("spec_attributes.id", ondelete="CASCADE"), nullable=False)
    value_code = Column(Text, nullable=False)
    value_label = Column(Text, nullable=False)
    value_number = Column(Numeric, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    scope = Column(Text, nullable=False, default="public")
    tenant_id = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="active")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_sav_attr", "attribute_id", "status"),
    )


class CategoryAttributeBinding(Base):
    """类目-属性挂载"""
    __tablename__ = "category_attribute_bindings"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    category_id = Column(BigInteger, ForeignKey("product_categories.id", ondelete="CASCADE"), nullable=False)
    attribute_id = Column(BigInteger, ForeignKey("spec_attributes.id", ondelete="CASCADE"), nullable=False)
    group_code = Column(Text, nullable=False)
    attr_role = Column(Text, nullable=False)  # key/sku/descriptive
    is_required = Column(Boolean, nullable=False, default=False)
    is_locked = Column(Boolean, nullable=False, default=False)
    sort_order = Column(Integer, nullable=False, default=0)
    default_value = Column(JSONB, nullable=True)
    depends_on = Column(JSONB, nullable=True)
    scope = Column(Text, nullable=False, default="public")
    tenant_id = Column(Text, nullable=True)
    schema_version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_cab_cat", "category_id", "scope", "tenant_id"),
    )


class IndustryTemplate(Base):
    """行业/客户模板"""
    __tablename__ = "industry_templates"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    industry_code = Column(Text, nullable=False)
    template_type = Column(Text, nullable=False)  # official/tenant/shared
    tenant_id = Column(Text, nullable=True)
    snapshot = Column(JSONB, nullable=False)
    snapshot_version = Column(Integer, nullable=False, default=1)
    usage_count = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_it_industry", "industry_code", "is_active"),
    )


class ProductSku(Base):
    """规格 SKU"""
    __tablename__ = "product_skus"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    category_id = Column(BigInteger, ForeignKey("product_categories.id", ondelete="RESTRICT"), nullable=False)
    spec_values = Column(JSONB, nullable=False)
    spec_hash = Column(Text, nullable=False)
    schema_version = Column(Integer, nullable=False, default=1)
    revision = Column(Integer, nullable=False, default=1)
    weight_kg = Column(Numeric, nullable=True)
    description = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_psk_lookup", "tenant_id", "category_id", "is_active"),
    )


class ProductSkuPrice(Base):
    """价格历史表"""
    __tablename__ = "product_sku_prices"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    sku_id = Column(BigInteger, ForeignKey("product_skus.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(Text, nullable=False)
    price = Column(Numeric(18, 4), nullable=False)
    currency = Column(Text, nullable=False, default="CNY")
    price_unit = Column(Text, ForeignKey("price_units.code"), nullable=False)
    min_qty = Column(Numeric, nullable=True)
    tier_rules = Column(JSONB, nullable=True)
    effective_from = Column(DateTime(timezone=True), nullable=False)
    effective_to = Column(DateTime(timezone=True), nullable=True)
    status = Column(Text, nullable=False, default="active")
    note = Column(Text, nullable=True)
    change_reason = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_psp_sku_active", "sku_id", "status", "effective_from"),
    )


class ProductSkuRevision(Base):
    """SKU 修订历史"""
    __tablename__ = "product_sku_revisions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    sku_id = Column(BigInteger, ForeignKey("product_skus.id", ondelete="CASCADE"), nullable=False)
    revision = Column(Integer, nullable=False)
    spec_values = Column(JSONB, nullable=False)
    spec_hash = Column(Text, nullable=False)
    schema_version = Column(Integer, nullable=False)
    change_reason = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_psr_sku", "sku_id"),
    )


class AttributeProposal(Base):
    """属性沉淀池"""
    __tablename__ = "attribute_proposals"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    category_id = Column(BigInteger, ForeignKey("product_categories.id", ondelete="CASCADE"), nullable=False)
    group_code = Column(Text, nullable=False)
    proposed_name = Column(Text, nullable=False)
    proposed_aliases = Column(JSONB, nullable=True, default=[])
    proposed_unit = Column(Text, nullable=True)
    proposed_unit_group = Column(Text, nullable=True)
    proposed_type = Column(Text, nullable=False)
    sample_values = Column(JSONB, nullable=True)
    occurrence_count = Column(Integer, nullable=False, default=1)
    similar_attribute_id = Column(BigInteger, ForeignKey("spec_attributes.id"), nullable=True)
    similarity_score = Column(Numeric, nullable=True)
    private_attribute_id = Column(BigInteger, ForeignKey("spec_attributes.id"), nullable=True)
    recommended_for_promotion = Column(Boolean, nullable=False, default=False)
    recommendation_score = Column(Numeric, nullable=True)
    recommended_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(Text, nullable=False, default="pending")
    reviewer = Column(Text, nullable=True)
    review_note = Column(Text, nullable=True)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
    promoted_attribute_id = Column(BigInteger, ForeignKey("spec_attributes.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_ap_status", "status", "category_id"),
    )


# ═══════════════════════════════════════════════════════════════
# FINANCIAL WORKSTATION: 智能开票工位模块 (v2 红蓝修复版)
# ═══════════════════════════════════════════════════════════════


class InvoiceRequest(Base):
    """
    开票请求表 — 红蓝修复版

    安全设计：
    - version 乐观锁 (SQLAlchemy version_id_col)
    - 覆盖审批机制（override_approved_by 需权限校验）
    - 状态机严格校验
    """
    __tablename__ = "invoice_requests"
    __mapper_args__ = {"version_id_col": "version"}

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False, index=True)
    customer_id = Column(BigInteger, ForeignKey("customers.id"), nullable=False)

    # ── 消息来源 ──
    wechat_message_id = Column(Text, nullable=False, unique=True)
    from_wechat_user_id = Column(Text, nullable=False)
    from_wechat_username = Column(Text, nullable=True)
    wechat_bot_account_id = Column(BigInteger, ForeignKey("wechat_bot_accounts.id"), nullable=False)
    wechat_conversation_id = Column(BigInteger, ForeignKey("wechat_conversations.id"), nullable=False)

    # ── 消息内容（纯文本存储，XSS 安全） ──
    raw_message_content = Column(Text, nullable=False)
    message_type = Column(Text, nullable=False)
    attached_image_urls = Column(ARRAY(Text), nullable=True)
    voice_transcription = Column(Text, nullable=True)

    # ── 提取参数 ──
    extracted_data = Column(JSONB, nullable=True)
    extraction_confidence = Column(Numeric(5, 4), nullable=True)
    extraction_issues = Column(JSONB, nullable=True)

    # ── 抬头匹配 ──
    matched_customer_header_id = Column(
        BigInteger, ForeignKey("customer_invoice_headers.id"), nullable=True
    )

    # ── 最终拼接的开票参数 ──
    merged_invoice_params = Column(JSONB, nullable=True)

    # ── 覆盖审批（红蓝修复：需权限校验） ──
    extracted_data_override = Column(JSONB, nullable=True)
    override_reason = Column(Text, nullable=True)
    override_approved_by = Column(BigInteger, ForeignKey("users.id"), nullable=True)
    override_approved_at = Column(DateTime(timezone=True), nullable=True)

    # ── 平台配置 ──
    invoice_platform_config_id = Column(
        BigInteger, ForeignKey("invoice_platform_configs.id"), nullable=True
    )

    # ── 开票结果 ──
    invoice_record_id = Column(BigInteger, ForeignKey("invoice_records.id"), nullable=True)

    # ── 状态与流程 ──
    status = Column(Text, nullable=False, default="pending_extraction", index=True)

    # ── 乐观锁（SQLAlchemy 自动管理） ──
    version = Column(Integer, nullable=False, default=1)

    # ── 人工处理 ──
    confirmed_by_user_id = Column(BigInteger, ForeignKey("users.id"), nullable=True)
    confirmation_timestamp = Column(DateTime(timezone=True), nullable=True)
    confirmation_notes = Column(Text, nullable=True)

    # ── 拒绝 ──
    rejection_reason = Column(Text, nullable=True)
    resubmitted_from_id = Column(BigInteger, nullable=True)

    # ── 时间戳 ──
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    extraction_completed_at = Column(DateTime(timezone=True), nullable=True)
    confirmation_deadline = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # ── 事件追踪 ──
    trace_id = Column(Text, nullable=True)
    sampled = Column(Boolean, nullable=False, default=True)

    __table_args__ = (
        Index("idx_invoice_request_tenant_status", "tenant_id", "status"),
        Index("idx_invoice_request_customer", "customer_id", "created_at"),
        Index("idx_invoice_request_wechat_msg", "wechat_message_id"),
        Index("idx_invoice_request_conv", "wechat_conversation_id"),
        Index("idx_invoice_request_deadline", "confirmation_deadline"),
        UniqueConstraint("invoice_record_id", name="uq_invoice_request_record"),
    )


class InvoiceRecord(Base):
    """
    发票记录表 — INSERT-only（数据库触发器强制执行）

    铁律：
    - 禁止 UPDATE/DELETE（数据库触发器阻止）
    - 如需修正，创建新版本记录
    """
    __tablename__ = "invoice_records"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False, index=True)
    invoice_request_id = Column(BigInteger, ForeignKey("invoice_requests.id"), nullable=False)

    invoice_number = Column(Text, nullable=False, unique=True)
    invoice_type = Column(Text, nullable=False)
    invoice_date = Column(Date, nullable=False)

    amount = Column(Numeric(12, 2), nullable=False)
    tax_amount = Column(Numeric(12, 2), nullable=False)
    total_amount = Column(Numeric(12, 2), nullable=False)

    pdf_url = Column(Text, nullable=True)
    pdf_hash = Column(Text, nullable=True)
    pdf_page_count = Column(Integer, nullable=True)

    platform_request_id = Column(Text, nullable=True)
    platform_response = Column(JSONB, nullable=True)

    status = Column(Text, nullable=False, default="issued")

    confirmed_by_user_id = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    confirmed_at = Column(DateTime(timezone=True), nullable=False)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_invoice_record_tenant", "tenant_id", "invoice_date"),
        Index("idx_invoice_record_request", "invoice_request_id"),
        Index("idx_invoice_record_number", "invoice_number"),
    )


class CustomerInvoiceHeader(Base):
    """
    客户发票抬头库 — 税务校验 + 版本控制

    安全设计：
    - verification_status 强制校验（pending 不可用于开票）
    - 银行账户 KMS 信封加密
    """
    __tablename__ = "customer_invoice_headers"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False, index=True)
    customer_id = Column(BigInteger, ForeignKey("customers.id"), nullable=False)

    company_name = Column(Text, nullable=False)
    uscc = Column(Text, nullable=True)
    tax_id = Column(Text, nullable=False)

    # ── 税务校验状态 ──
    verification_status = Column(
        Text, nullable=False, default="pending"
    )  # pending | verified | failed | expired
    verification_source = Column(Text, nullable=True)
    verification_checked_at = Column(DateTime(timezone=True), nullable=True)
    verification_response = Column(JSONB, nullable=True)

    registered_address = Column(Text, nullable=False)
    registered_province = Column(Text, nullable=True)
    registered_city = Column(Text, nullable=True)
    phone_number = Column(Text, nullable=True)

    # ── 银行账户（KMS 信封加密） ──
    bank_name = Column(Text, nullable=True)
    bank_account_encrypted = Column(Text, nullable=True)
    bank_account_kms_key_id = Column(Text, nullable=True)

    is_primary = Column(Boolean, nullable=False, default=False)
    status = Column(Text, nullable=False, default="active")

    effective_from = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    effective_to = Column(DateTime(timezone=True), nullable=True)
    previous_version_id = Column(BigInteger, nullable=True)

    created_by = Column(BigInteger, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_invoice_header_customer", "customer_id", "is_primary"),
        Index("idx_invoice_header_tax_id", "tax_id"),
        Index("idx_invoice_header_active", "customer_id", "status", "effective_to"),
    )


class InvoicePlatformConfig(Base):
    """
    开票平台对接配置 — KMS 加密 + HTTPS 强制

    安全设计：
    - credentials_kms_key_id 白名单校验
    - api_endpoint HTTPS 强制（数据库 CHECK 约束）
    - 每日配额控制
    """
    __tablename__ = "invoice_platform_configs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False, index=True)

    # ── 平台标识（可扩展：任意平台名称，不硬编码） ──
    platform_name = Column(Text, nullable=False)
    platform_display_name = Column(Text, nullable=False)

    api_endpoint = Column(Text, nullable=False)
    api_version = Column(Text, nullable=True, default="v1")

    # ── KMS 信封加密 ──
    credentials_encrypted = Column(Text, nullable=False)
    credentials_kms_key_id = Column(Text, nullable=False)
    credentials_encryption_context = Column(JSONB, nullable=False)

    config_params = Column(JSONB, nullable=True)

    is_enabled = Column(Boolean, nullable=False, default=True)
    is_primary = Column(Boolean, nullable=False, default=False)

    last_health_check_at = Column(DateTime(timezone=True), nullable=True)
    health_check_status = Column(Text, nullable=True)
    health_check_error_msg = Column(Text, nullable=True)

    daily_quota = Column(Integer, nullable=True)
    daily_used_count = Column(Integer, nullable=False, default=0)
    quota_reset_at = Column(DateTime(timezone=True), nullable=True)

    created_by = Column(BigInteger, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_platform_config_tenant", "tenant_id", "is_enabled"),
        Index("idx_platform_config_primary", "tenant_id", "is_primary"),
        CheckConstraint("api_endpoint LIKE 'https://%'", name="chk_platform_https"),
    )


class InvoiceTemplate(Base):
    """
    开票模板库 — 商品编码映射（可扩展）

    设计目标：
    - 支持任意商品编码体系（不绑定特定税务系统）
    - 租户可自定义映射
    - 使用频率排序，AI 优先推荐
    """
    __tablename__ = "invoice_templates"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False, index=True)
    customer_id = Column(BigInteger, nullable=True)

    tax_code = Column(Text, nullable=False)
    tax_code_name = Column(Text, nullable=False)
    nickname = Column(Text, nullable=False)
    synonyms = Column(ARRAY(Text), nullable=True)

    default_tax_rate = Column(Numeric(5, 4), nullable=False)
    tax_rate_options = Column(ARRAY(Numeric(5, 4)), nullable=True)

    default_unit = Column(Text, nullable=False, default="项")
    unit_options = Column(ARRAY(Text), nullable=True)

    category = Column(Text, nullable=True)
    sub_category = Column(Text, nullable=True)

    priority_score = Column(Integer, nullable=False, default=0)
    usage_count = Column(Integer, nullable=False, default=0)
    last_used_at = Column(DateTime(timezone=True), nullable=True)

    status = Column(Text, nullable=False, default="active")

    created_by = Column(BigInteger, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_template_tenant_category", "tenant_id", "category"),
        Index("idx_template_tax_code", "tax_code"),
        Index("idx_template_priority", "priority_score", "usage_count"),
    )


class FinancialWorkstationSession(Base):
    """
    财务工位会话表 — 原子抢占 + 超时回收

    安全设计：
    - claim 使用 FOR UPDATE SKIP LOCKED
    - 查询时懒检查超时（不依赖 cron）
    """
    __tablename__ = "financial_workstation_sessions"
    __mapper_args__ = {"version_id_col": "version"}

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False, index=True)
    invoice_request_id = Column(BigInteger, ForeignKey("invoice_requests.id"), nullable=False)

    assigned_to_user_id = Column(BigInteger, ForeignKey("users.id"), nullable=True)
    workstation_name = Column(Text, nullable=True)

    status = Column(Text, nullable=False, default="pending")

    assigned_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    viewed_at = Column(DateTime(timezone=True), nullable=True)
    processing_started_at = Column(DateTime(timezone=True), nullable=True)
    timeout_at = Column(DateTime(timezone=True), nullable=True)

    action_history = Column(JSONB, nullable=True)

    device_ip = Column(Text, nullable=True)
    device_user_agent = Column(Text, nullable=True)

    priority = Column(Integer, nullable=False, default=0)

    version = Column(Integer, nullable=False, default=1)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_workstation_session_user", "assigned_to_user_id", "status"),
        Index("idx_workstation_session_invoice", "invoice_request_id"),
        Index("idx_workstation_session_timeout", "timeout_at"),
    )


class InvoiceAuditLog(Base):
    """
    审计日志 — 哈希链 + 外部不可变存储

    安全设计：
    - 同一事务写入（原子性）
    - previous_hash / current_hash 链式校验
    - MinIO 异步归档（最终一致性）
    """
    __tablename__ = "invoice_audit_logs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False, index=True)

    event_type = Column(Text, nullable=False)
    actor_id = Column(BigInteger, nullable=True)
    resource_type = Column(Text, nullable=False)
    resource_id = Column(Text, nullable=False)
    action = Column(Text, nullable=False)
    changes = Column(JSONB, nullable=True)

    previous_hash = Column(Text, nullable=True)
    current_hash = Column(Text, nullable=False)

    minio_status = Column(Text, nullable=False, default="pending")  # pending | archived | failed
    minio_object_key = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_inv_audit_tenant_event", "tenant_id", "event_type", "created_at"),
        Index("idx_inv_audit_resource", "resource_type", "resource_id"),
    )

