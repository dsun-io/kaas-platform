"""
Kaas v2 · SQLAlchemy ORM 模型
────────────────────────────
严格对应 v2 设计文档 §3.5 / §3.7 的表结构。

铁律遵守:
- 所有事实表有 schema_version (§3.7.2)
- events 表 INSERT-only (铁律5)
- quotations 表 INSERT-only, 不存 effective_to (§3.5.2)
- 字段命名: created_at (非 occurred_at), quote.response (非 quote.requested)
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
)
from sqlalchemy.dialects.postgresql import JSONB
from app.db.base import Base


class Event(Base):
    """
    L0 原始事件流（飞轮唯一入口 · 永久归档 · 铁律5）

    所有原始事件统一落此表，不分散到各业务表。
    INSERT-only: 禁止 UPDATE / DELETE。
    """

    __tablename__ = "events"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    schema_version = Column(Integer, nullable=False, default=1)
    tenant_id = Column(Text, nullable=False)
    event_type = Column(Text, nullable=False)     # chat.turn / quote.request / quote.response / ...
    event_source = Column(Text, nullable=False)   # frontend / orchestrator / fastgpt_callback / scheduled
    actor_id = Column(Text, nullable=True)
    session_id = Column(Text, nullable=True)
    payload = Column(JSONB, nullable=False)
    trace_id = Column(Text, nullable=True)
    sampled = Column(Boolean, nullable=False, default=True)
    # v2 修正: 使用 created_at (非 occurred_at)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_events_tenant_type_time", "tenant_id", "event_type", created_at.desc()),
        Index("idx_events_session", "session_id", postgresql_where=(session_id.isnot(None))),
    )


class Quotation(Base):
    """
    L4 报价事实表（永远 INSERT，不 UPDATE · 铁律5）

    不存 effective_to，靠 INSERT-only + ORDER BY effective_from DESC LIMIT 1
    永远取到最新一条（§3.5.2）。
    """

    __tablename__ = "quotations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    schema_version = Column(Integer, nullable=False, default=1)
    customer_id = Column(Text, nullable=False)
    product_category = Column(Text, nullable=False)
    product_spec = Column(JSONB, nullable=False)
    spec_hash = Column(Text, nullable=False)
    unit_price = Column(Numeric(10, 4), nullable=True)   # NULL = 显式废止
    currency = Column(Text, nullable=False, default="CNY")
    unit = Column(Text, nullable=False)                   # 元/米 | 元/平 | 元/吨 | 元/卷
    discount = Column(Numeric(5, 4), nullable=True)
    min_quantity = Column(Integer, nullable=True)
    effective_from = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    source = Column(Text, nullable=False)                 # manual | chat_extracted | system_estimated
    notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    # v2 修正: 使用 created_at (非 occurred_at)
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
    客户支持的生产规格（David Q2 补充：防止 AI 推荐做不出的规格）

    权威数据源在 PostgreSQL，L3 FastGPT dataset 仅放可读副本。
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
