"""
Kaas v2 · SQLAlchemy ORM 模型
────────────────────────────
INT-R3: 平台规格与客户私有数据分离。
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
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
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
