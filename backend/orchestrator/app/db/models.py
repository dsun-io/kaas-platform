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


class CustomerQuoteProfile(Base):
    """客户报价税率档案 —— 「这个客户填过的那套税率，下次一键套用」。

    只装**税率类**参数（进项票税点 / 销项税率 / 出口退税率 / 印花税率 + 基数），
    外加它当时绑定的**法定税务档案编号**。

    为什么必须连 rate_set_code 一起存
    ---------------------------------
    报价页把「法定税务档案」和「客户档案」放在同一个下拉里（业务选择：并入现有下拉），
    所以选中某份客户档案时，法定档案也必须跟着切回它当时那一份。
    否则「客户档案 + 另一份法定档案」会算出一个谁都没确认过的组合 ——
    而且金额看起来完全正常，没人会发现。

    为什么另建一张表，不去用 customer_pricing_profiles
    ------------------------------------------------
    那张旧表是 INT-R3 时代的模型（三档加价倍率 + 单一税点）。
    **它的读取路径已于 2026-10-11 整体删除**：
    `services/quote_engine.py` → `services/niulanwang_pricing.py` →
    `repositories/pricing_profiles_repo.py` 三个文件全链删除
    （死代码：没有任何 API 调用它，唯一引用是 `services/__init__` 的再导出
    和一个测试里的 `assert is not None`）。

    原先的隐患正是那条路径造成的：把新模型的行插进旧表，
    老路径会按「加价倍率」解读它们 —— 读到 null / 垃圾值继续算，
    **不报错、不告警**。读取路径删掉后，这个隐患随之消失。

    表本身**保留**（里面有历史数据；删表是破坏性动作，需单独决定）。
    它现在是**退役状态**：没有任何代码读它，也没有新的写入路径。

    tax_overrides 用 JSONB 而非展开成列
    ----------------------------------
    它是**报价政策的一份覆盖**，形状与 policy 保持一致，引擎消费的本来就是个 dict。
    税率项还在增加（以后可能加消费税等），展开成列会让每加一项都动一次迁移。
    代价是键名没有数据库层约束 —— 所以在 API 写入时按白名单校验，不让错键进库。
    """
    __tablename__ = "customer_quote_profiles"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    customer_id = Column(Text, nullable=False)
    # 用引擎的产品 key（如 field_fence），不用中文名 —— 全链路一个标识，避免两套对不上
    product_key = Column(Text, nullable=False)
    profile_name = Column(Text, nullable=False)
    # 当时绑定的法定税务档案（如 CN-2026-09）；选中本档案时一并切过去
    rate_set_code = Column(Text, nullable=False)
    # 税率覆盖项，见 API 层的白名单
    tax_overrides = Column(JSONB, nullable=False, default=dict)
    status = Column(Text, nullable=False, default="active")
    source = Column(Text, nullable=False, default="manual")
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    # onupdate：改名/改内容时由 SQLAlchemy 自动刷成 now()。
    # 不能靠 server_default —— 那只作用于 INSERT，UPDATE 时不会变。
    updated_at = Column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        Index(
            "idx_quote_profile_lookup",
            "tenant_id",
            "customer_id",
            "product_key",
            "status",
        ),
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
    # 官网数据后台权限（2026-10-11 拆分模型）：**独立于团队角色**的一项授权 ——
    # 团队管理员按需授予普通成员，默认关闭。判定见 app/api/teams.py 的
    # `PUT /teams/{team_id}/members/{user_id}/console-access`（唯一写入口）。
    console_access = Column(Boolean, nullable=False, default=False, server_default="false")
    # 三层组织：成员归属的团队（NULL = 未分组）。可见性判定见
    # kaas_common/workstation/scope.py —— 成员创建的数据本团队可见。
    team_id = Column(BigInteger, ForeignKey("teams.id", ondelete="SET NULL"), nullable=True)
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


class Team(Base):
    """团队（三层组织：管理员 / 团队 / 成员）。

    成员创建的数据**本团队可见、其他团队不可见** —— 判定见
    `kaas_common/workstation/scope.py`（两端共用同一份规则）。
    业务行上直接记 `team_id`（写入时取创建者的团队），而不是靠 owner 反查：
    这样判定无需 JOIN，且成员换团队后数据仍留在原团队。
    """
    __tablename__ = "teams"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    # 团队管理员 = 团队创建者（业务规则：团队由第一个成员创建，创建者可管理本团队）
    created_by = Column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("uq_teams_tenant_name", "tenant_id", "name", unique=True),
    )


class TeamSubscription(Base):
    """团队工位订阅（团队开通 = 全员可用）。

    判定真源 = `kaas_common/workstation/subscriptions.py`。
    `source`：manual（后台手动开通）/ payment（付费）/ system_migration。
    """
    __tablename__ = "team_subscriptions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    team_id = Column(BigInteger, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    code = Column(Text, nullable=False)                 # 工位 key 或 full_chain
    active = Column(Boolean, nullable=False, server_default="true")
    expires_at = Column(DateTime(timezone=True), nullable=True)
    source = Column(Text, nullable=False, server_default="manual")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("uq_team_subscriptions_code", "team_id", "code", unique=True),
        Index("idx_team_subscriptions_active", "team_id", "active"),
    )


class UserSubscription(Base):
    """个人工位订阅（某人额外单独开通的工位）。"""
    __tablename__ = "user_subscriptions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    code = Column(Text, nullable=False)
    active = Column(Boolean, nullable=False, server_default="true")
    expires_at = Column(DateTime(timezone=True), nullable=True)
    source = Column(Text, nullable=False, server_default="manual")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("uq_user_subscriptions_code", "user_id", "code", unique=True),
        Index("idx_user_subscriptions_active", "user_id", "active"),
    )


class TeamInvite(Base):
    """团队邀请（邮箱点名 or 通用邀请码）。

    加入现有团队**必须凭邀请码** —— 否则 A 公司的人可以自由进入 B 公司团队。
    规则真源 = `kaas_common/workstation/teams.py`（两端共用）。
    """
    __tablename__ = "team_invites"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    team_id = Column(BigInteger, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    email = Column(Text, nullable=True)          # 邮箱点名时才填
    token = Column(Text, nullable=False, unique=True)
    invited_by = Column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    status = Column(Text, nullable=False, server_default="pending")  # pending|accepted|revoked
    expires_at = Column(DateTime(timezone=True), nullable=True)
    accepted_at = Column(DateTime(timezone=True), nullable=True)
    accepted_by = Column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_team_invites_team", "team_id", "status"),
        Index("idx_team_invites_email", "email"),
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
    # ── 阶段2 客户表合并：吸收 cust_customers 的档案列（2026-09-22）──
    country = Column(Text, nullable=True)
    address = Column(Text, nullable=True)
    default_port = Column(Text, nullable=True)
    credit_level = Column(Text, nullable=True)
    stage = Column(Text, nullable=False, default="lead", server_default="lead")
    notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    owner_id = Column(Text, nullable=True)
    owner_scope = Column(Text, nullable=False, default="private", server_default="private")
    # 三层组织：本行归属的团队（写入时取创建者的团队；NULL = 未分组，保持原有可见性）
    team_id = Column(BigInteger, ForeignKey("teams.id", ondelete="SET NULL"), nullable=True)
    legacy_cust_id = Column(BigInteger, nullable=True)  # 合并映射键（旧 cust_customers.id），仅供 downgrade 还原
    # ── 202610100004 客户软删除（保留历史单据引用，不物理删除）──
    is_deleted = Column(Boolean, nullable=False, default=False, server_default="false")
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_customers_tenant", "tenant_id"),
        Index("idx_customers_code", "code"),
    )


class TenantProduct(Base):
    """租户级产品定义（运行时配置化）。

    加载优先级：tenant_products（租户级）> products/ Python 定义（系统级兜底）。
    权限矩阵（**未完成**）：is_system=true 系统级产品所有租户可见，
    is_system=false 租户级产品仅本租户可见。
    详见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md
    """
    __tablename__ = "tenant_products"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    product_key = Column(Text, nullable=False)
    product_name = Column(Text, nullable=False)
    product_name_en = Column(Text, nullable=True)
    category_code = Column(Text, nullable=True)
    cost_field = Column(Text, nullable=True, default="raw_price")
    cost_basis = Column(Text, nullable=True, default="pretax")
    cost_unit = Column(Text, nullable=True)
    # 产品级利润配置（优先级：产品级 > 报价单级 > 税务档案）
    profit_mode = Column(Text, nullable=True, default="margin_on_price")
    profit_value = Column(Numeric(10, 6), nullable=True, default=0.06)
    misc_fee_rate = Column(Numeric(10, 6), nullable=True, default=0.03)
    # 完整 ProductSpec（JSONB，含 axes/variants/derived/columns/invariants）
    spec = Column(JSONB, nullable=False)
    is_system = Column(Boolean, nullable=False, default=False, server_default="false")
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("uq_tenant_products_key", "tenant_id", "product_key", unique=True),
        Index("idx_tenant_products_tenant", "tenant_id", "is_active"),
    )


class TeamOptionOverride(Base):
    """团队级的产品档位覆盖（**改显示名 / 软停用**）。

    为什么是**团队级**（2026-10-11 用户裁决）：档位 = 公司能做什么，
    不该因买家而异；而 `tenant_id` 恒为 "default"、已不是隔离边界，
    **团队才是**。成本价则相反 —— 那是"不同买家拿到不同价"的商务差异，
    继续按买家客户存在定价数据里（`customer_cost_items`），不动。

    为什么不复用 `tenant_products`：那张表存的是**完整 ProductSpec 快照**，
    把几个档位的改名写进去，会让该租户的产品定义**冻成快照** ——
    以后代码改了产品定义它不跟着变。所以单开一张轻量表，只存覆盖。

    载荷（`overrides`）形如::

        {"coating_code": {"rename": {"zinc_40": "40克锌层"},
                          "disabled": ["pvc_black"]}}

    两条硬约束：
      · **只改显示名，不改 code** —— code 是查价键的一半
        （`pricing_key_of` 拼的就是它），一改历史定价数据与报价单就对不上。
      · **停用是软停用** —— 从下拉里消失，但引擎仍能解析它，
        否则已引用该档位的历史报价单重算会取不到档位。
    """

    __tablename__ = "team_option_overrides"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    team_id = Column(BigInteger, ForeignKey("teams.id", ondelete="CASCADE"),
                     nullable=False)
    product_key = Column(Text, nullable=False)
    overrides = Column(JSONB, nullable=False, default=dict,
                       server_default="{}")
    created_at = Column(DateTime(timezone=True), nullable=False,
                        server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False,
                        server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("uq_team_option_overrides", "team_id", "product_key", unique=True),
    )


class TenantWorkstationProduct(Base):
    """租户开通报价工位后选择启用产品（多对多）。

    权限矩阵：
    - is_system=true：系统级产品，所有租户可见，仅平台管理员可编辑
    - is_system=false：租户级产品，仅本租户可见，租户管理员可编辑
    详见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md
    """
    __tablename__ = "tenant_workstation_products"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    workstation = Column(Text, nullable=False)  # e.g. "quote"
    product_key = Column(Text, nullable=False)
    is_enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("uq_tenant_ws_product", "tenant_id", "workstation", "product_key", unique=True),
        Index("idx_tenant_ws_product_tenant", "tenant_id", "workstation", "is_enabled"),
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
# AUTH-WX-R1: 渠道链接与用量事件（保留；微信表已于清理阶段删除）
# ═══════════════════════════════════════════════════════════════


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


# ─── Intel Workstation (商情雷达 · 进出口数据工位) ───


class IntelEntity(Base):
    """商情雷达 · 企业实体表（买卖双方/货代/通知方）"""
    __tablename__ = 'intel_entities'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    entity_type = Column(Text, nullable=False)  # shipper | consignee | carrier | notify_party
    name_raw = Column(Text, nullable=False)
    name_norm = Column(Text, nullable=True)
    country = Column(Text, nullable=True)
    city = Column(Text, nullable=True)
    address = Column(Text, nullable=True)
    contact_info = Column(JSONB, nullable=True)
    is_verified = Column(Boolean, nullable=False, default=False)
    source_channel = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('idx_intel_entities_tenant', 'tenant_id', 'entity_type'),
        Index('idx_intel_entities_name', 'tenant_id', 'name_norm'),
    )


class IntelProductCategory(Base):
    """商情雷达 · 产品类目树"""
    __tablename__ = 'intel_product_categories'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    parent_id = Column(BigInteger, ForeignKey('intel_product_categories.id'), nullable=True)
    name = Column(Text, nullable=False)
    hs_code = Column(Text, nullable=True)
    description = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('idx_intel_pc_tenant', 'tenant_id', 'parent_id'),
    )


class IntelShipment(Base):
    """商情雷达 · 进出口数据核心表（谁 什么时间 通过谁 向什么地区 给谁 发了什么货）"""
    __tablename__ = 'intel_shipments'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)

    # 核心数据链
    shipper = Column(Text, nullable=False)  # 发货人
    ship_date = Column(DateTime(timezone=True), nullable=True)  # 发货时间
    carrier = Column(Text, nullable=True)  # 承运人/货代
    notify_party = Column(Text, nullable=True)  # 通知方
    origin_port = Column(Text, nullable=True)  # 起运港
    origin_country = Column(Text, nullable=True)  # 起运国
    dest_port = Column(Text, nullable=True)  # 目的港
    dest_country = Column(Text, nullable=True)  # 目的国
    consignee = Column(Text, nullable=False)  # 收货人
    product_desc = Column(Text, nullable=False)  # 产品描述
    product_desc_norm = Column(Text, nullable=True)  # 标准化产品描述
    hs_code = Column(Text, nullable=True)  # HS 编码
    category_id = Column(BigInteger, ForeignKey('intel_product_categories.id'), nullable=True)

    # 数量与重量
    qty = Column(Numeric, nullable=True)
    qty_unit = Column(Text, nullable=True)
    gross_weight_kg = Column(Numeric, nullable=True)
    net_weight_kg = Column(Numeric, nullable=True)
    volume_cbm = Column(Numeric, nullable=True)

    # 集装箱与运输
    container_no = Column(Text, nullable=True)
    container_type = Column(Text, nullable=True)
    bl_no = Column(Text, nullable=True)  # 提单号
    voyage_no = Column(Text, nullable=True)  # 航次号

    # 金额
    declared_value = Column(Numeric, nullable=True)
    currency = Column(Text, nullable=True)

    # 其他
    marks = Column(Text, nullable=True)  # 唛头
    remarks = Column(Text, nullable=True)  # 备注
    shipment_type = Column(Text, nullable=True)  # FCL | LCL | Air | Rail
    incoterm = Column(Text, nullable=True)
    freight_prepaid = Column(Boolean, nullable=True)

    # 数据来源
    source_channel = Column(Text, nullable=False)  # un_comtrade | manual_excel | manual_csv | govt_procurement | api_import
    source_ref = Column(Text, nullable=True)  # 原始数据引用/URL/文件路径
    raw_data = Column(JSONB, nullable=True)  # 原始数据 JSON

    # 实体关联（标准化后）
    shipper_entity_id = Column(BigInteger, ForeignKey('intel_entities.id'), nullable=True)
    consignee_entity_id = Column(BigInteger, ForeignKey('intel_entities.id'), nullable=True)
    notify_entity_id = Column(BigInteger, ForeignKey('intel_entities.id'), nullable=True)
    carrier_entity_id = Column(BigInteger, ForeignKey('intel_entities.id'), nullable=True)

    # 元数据
    is_verified = Column(Boolean, nullable=False, default=False)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('idx_intel_shipments_tenant_date', 'tenant_id', 'ship_date'),
        Index('idx_intel_shipments_tenant_shipper', 'tenant_id', 'shipper'),
        Index('idx_intel_shipments_tenant_consignee', 'tenant_id', 'consignee'),
        Index('idx_intel_shipments_tenant_dest', 'tenant_id', 'dest_country'),
        Index('idx_intel_shipments_tenant_hs', 'tenant_id', 'hs_code'),
    )


class IntelSource(Base):
    """数据源注册表"""
    __tablename__ = 'intel_sources'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    source_type = Column(Text, nullable=False)  # un_comtrade | govt_procurement | paid_customs | manual_import
    url = Column(Text, nullable=True)
    api_key = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    config = Column(JSONB, nullable=True)
    last_run_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('idx_intel_sources_tenant', 'tenant_id', 'source_type'),
    )


class IntelTradeStat(Base):
    """贸易统计聚合（Comtrade 等宏观数据）"""
    __tablename__ = 'intel_trade_stats'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    hs_code = Column(Text, nullable=False)
    period = Column(Text, nullable=False)  # YYYY-MM
    reporter_country = Column(Text, nullable=True)  # 报告国
    partner_country = Column(Text, nullable=False)  # 贸易伙伴国
    trade_flow = Column(Text, nullable=False)  # import | export
    qty = Column(Numeric, nullable=True)
    qty_unit = Column(Text, nullable=True)
    value_usd = Column(Numeric, nullable=True)
    source_channel = Column(Text, nullable=False, default='un_comtrade')
    raw_data = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('idx_intel_trade_stats_lookup', 'tenant_id', 'hs_code', 'period', 'partner_country'),
    )


class IntelDataChannel(Base):
    """数据渠道注册（免费/付费）"""
    __tablename__ = 'intel_data_channels'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    channel_type = Column(Text, nullable=False)  # comtrade | bl_awards | exhibitor | importer_bill
    tier = Column(Text, nullable=False, default='free')  # free | paid
    is_enabled = Column(Boolean, nullable=False, default=False)
    config = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('idx_intel_channels_tenant', 'tenant_id', 'channel_type'),
    )


class IntelAdapterRun(Base):
    """采集任务运行日志"""
    __tablename__ = 'intel_adapter_runs'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    source_id = Column(BigInteger, ForeignKey('intel_sources.id'), nullable=True)
    channel_id = Column(BigInteger, ForeignKey('intel_data_channels.id'), nullable=True)
    status = Column(Text, nullable=False)  # success | failed | running
    started_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    finished_at = Column(DateTime(timezone=True), nullable=True)
    items_processed = Column(Integer, nullable=False, default=0)
    items_inserted = Column(Integer, nullable=False, default=0)
    error_message = Column(Text, nullable=True)
    run_metadata = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('idx_intel_adapter_runs_tenant', 'tenant_id', 'started_at'),
    )


class IntelKeywordRule(Base):
    """关键词词表（zh/en）"""
    __tablename__ = 'intel_keyword_rules'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    category_id = Column(BigInteger, ForeignKey('intel_product_categories.id'), nullable=True)
    keyword = Column(Text, nullable=False)
    lang = Column(Text, nullable=False, default='zh')  # zh | en
    match_type = Column(Text, nullable=False, default='include')  # include | exclude
    weight = Column(Integer, nullable=False, default=1)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index('idx_intel_keywords_tenant', 'tenant_id', 'category_id', 'lang'),
    )


class IntelMatch(Base):
    """匹配记录/跟进状态"""
    __tablename__ = 'intel_matches'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    match_type = Column(Text, nullable=False)  # tender | shipment | entity
    ref_id = Column(BigInteger, nullable=False)  # 关联记录 ID
    category_id = Column(BigInteger, ForeignKey('intel_product_categories.id'), nullable=True)
    matched_keywords = Column(JSONB, nullable=True)
    relevance = Column(Text, nullable=False, default='product')  # product | local | both
    status = Column(Text, nullable=False, default='new')  # new | read | following | bid_won | bid_lost
    follow_notes = Column(Text, nullable=True)
    followed_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('idx_intel_matches_tenant', 'tenant_id', 'match_type', 'status'),
    )


# ─────────────────────────────────────────────────────────────────────────────
# 工作站互联 Schema 口子（Workstation Links）
# 依据 docs/WORKSTATION_DESIGN.md §5-§6 建立。
# ─────────────────────────────────────────────────────────────────────────────
class BusinessEvent(Base):
    """跨工位业务事件流水（阶段 6 · 工位能力网事件流，共 11 类）。"""
    __tablename__ = "business_events"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    event_type = Column(Text, nullable=False)
    from_workstation = Column(Text, nullable=True)
    to_workstation = Column(Text, nullable=True)
    payload = Column(JSONB, nullable=True)
    actor_id = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_business_events_tenant_time", "tenant_id", "created_at"),
        Index("idx_business_events_tenant_type", "tenant_id", "event_type"),
    )


from app.db.workstation_links import (  # noqa: E402,F401
    QuoteOrder,
    QuoteOrderItem,
    QuoteOrderShipmentRef,
    Order,
    OrderItem,
    OrderQuoteRef,
    OrderShipmentRef,
    TradeDoc,
    TradeDocItem,
    TradeDocOrderRef,
)
