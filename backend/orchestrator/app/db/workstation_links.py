# ─────────────────────────────────────────────────────────────────────────────
# 工作站互联 Schema 口子（Workstation Links）
# 依据 docs/WORKSTATION_DESIGN.md §5-§6 建立。
# 涵盖：报价工位 / 订单工位 / 外贸票据工位 的主表 + 跨工位关联表。
# 当前阶段仅建表（Phase 2），业务逻辑在后续工位开发时填充。
# ─────────────────────────────────────────────────────────────────────────────
from sqlalchemy import (
    Column, BigInteger, Integer, Text, Numeric, DateTime, Index, func,
)
from sqlalchemy.dialects.postgresql import JSONB
from app.db.base import Base


class QuoteOrder(Base):
    """报价工位 · 报价单头（预留口子）"""
    __tablename__ = "quote_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    quote_no = Column(Text, nullable=False, unique=True)
    customer_id = Column(Text, nullable=True)
    customer_name = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="draft")
    currency = Column(Text, nullable=False, default="USD")
    total_amount = Column(Numeric, nullable=True)
    valid_until = Column(DateTime(timezone=True), nullable=True)
    notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
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
    customer_id = Column(Text, nullable=True)
    customer_name = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="pending")
    currency = Column(Text, nullable=False, default="USD")
    total_amount = Column(Numeric, nullable=True)
    order_date = Column(DateTime(timezone=True), nullable=True)
    delivery_date = Column(DateTime(timezone=True), nullable=True)
    notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
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
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_order_items_order", "tenant_id", "order_id"),
    )


class OrderQuoteRef(Base):
    """关联表：销售订单 ↔ 报价单（转化来源）"""
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
    customer_id = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="draft")
    currency = Column(Text, nullable=False, default="USD")
    total_amount = Column(Numeric, nullable=True)
    issued_at = Column(DateTime(timezone=True), nullable=True)
    issued_by = Column(Text, nullable=True)
    raw_payload = Column(JSONB, nullable=True)
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
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_trade_doc_items_doc", "tenant_id", "trade_doc_id"),
    )


class TradeDocOrderRef(Base):
    """关联表：票据 ↔ 销售订单（票据来源）"""
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
