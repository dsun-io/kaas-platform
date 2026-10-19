"""worker 独有/历史遗留表模型（方案 B 阶段二 S2 · schema 完备性）

背景
----
空库快径 = `Base.metadata.create_all()` + stamp head（见 `migration_bootstrap.py`）。
历史上有 8 张表**只存在于生产库**（由早期一次性脚本建立、既无迁移也无 ORM 模型），
但 worker 的 SQL 在查询/写入它们 ⇒ 全新环境（预览/新生产）执行 `alembic upgrade head`
后仍缺这些表，相关接口必 500。

本文件按**生产库真实 DDL**（2026-10-19 只读 dump `information_schema` + `pg_constraint`
+ `pg_indexes`，Neon PG 18.6）补齐模型，使 metadata 与生产一致。
生产行数：entity_links 3 / file_objects 5，其余为 0。

维护约定
--------
- 这些表**不再新增业务列**；新功能请用新表+迁移，不要改这里（保持与生产 DDL 一致）。
- `scripts/check-schema-coverage.py` 会校验「worker SQL 引用的表 ⊆ metadata」。
"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    Table,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

from app.db.base import Base


class EntityLink(Base):
    """多态实体关联（entity_links）。"""

    __tablename__ = "entity_links"

    id = Column(BigInteger, primary_key=True)
    tenant_id = Column(Text, nullable=False)
    src_type = Column(Text, nullable=False)
    src_id = Column(BigInteger, nullable=False)
    dst_type = Column(Text, nullable=False)
    dst_id = Column(BigInteger, nullable=False)
    rel_type = Column(Text, nullable=False)
    meta = Column(JSONB, nullable=True)
    created_by = Column(BigInteger, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=text("now()"))
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "src_type", "src_id", "dst_type", "dst_id", "rel_type",
            name="uq_entity_links",
        ),
        Index(
            "idx_entity_links_src",
            "tenant_id", "src_type", "src_id", "rel_type",
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index(
            "idx_entity_links_dst",
            "tenant_id", "dst_type", "dst_id", "rel_type",
            postgresql_where=text("deleted_at IS NULL"),
        ),
    )


class FeatureFlagAudit(Base):
    """功能开关审计（feature_flag_audit）。"""

    __tablename__ = "feature_flag_audit"

    id = Column(BigInteger, primary_key=True)
    action = Column(Text, nullable=False)
    actor_id = Column(Text, nullable=True)
    tenant_id = Column(Text, nullable=False)
    resource_type = Column(Text, nullable=False)
    resource_id = Column(Text, nullable=True)
    flag_name = Column(Text, nullable=True)
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    reason = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=text("now()"))

    __table_args__ = (
        Index("idx_feature_flag_audit_tenant", "tenant_id", "created_at"),
    )


class FeatureFlag(Base):
    """租户级功能开关（feature_flags）。"""

    __tablename__ = "feature_flags"

    id = Column(BigInteger, primary_key=True)
    tenant_id = Column(Text, nullable=False)
    flag_name = Column(Text, nullable=False)
    flag_value = Column(Boolean, nullable=False, server_default=text("false"))
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=text("now()"))
    updated_by = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_feature_flags_tenant_flag", "tenant_id", "flag_name", unique=True),
    )


class FileObject(Base):
    """文件元数据（file_objects）；字节落 S3/R2/inline。"""

    __tablename__ = "file_objects"

    id = Column(BigInteger, primary_key=True)
    tenant_id = Column(Text, nullable=False)
    team_id = Column(BigInteger, nullable=True)
    owner_type = Column(Text, nullable=False)
    owner_id = Column(Text, nullable=True)
    kind = Column(Text, nullable=False)
    media_kind = Column(Text, nullable=True)
    name = Column(Text, nullable=False)
    storage = Column(Text, nullable=False, server_default=text("'s3'::text"))
    object_key = Column(Text, nullable=True)
    content = Column(LargeBinary, nullable=True)
    file_name = Column(Text, nullable=True)
    content_type = Column(Text, nullable=True)
    file_size = Column(BigInteger, nullable=True)
    sha256 = Column(Text, nullable=True)
    version = Column(Integer, nullable=False, server_default=text("1"))
    supersedes_id = Column(BigInteger, ForeignKey("file_objects.id"), nullable=True)
    is_current = Column(Boolean, nullable=False, server_default=text("true"))
    uploaded_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=text("now()"))
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=text("now()"))
    is_primary = Column(Boolean, nullable=False, server_default=text("false"))
    sort_order = Column(Integer, nullable=False, server_default=text("0"))

    __table_args__ = (
        Index("idx_file_objects_kind", "tenant_id", "kind", "is_current"),
        Index("idx_file_objects_owner", "tenant_id", "owner_type", "owner_id"),
        Index("idx_file_objects_sha", "tenant_id", "sha256"),
        Index(
            "uq_file_current",
            "tenant_id", "owner_type", "owner_id", "kind", "media_kind",
            unique=True,
            postgresql_where=text(
                "is_current AND kind = ANY (ARRAY['stamp_scan'::text, 'render_pdf'::text])"
            ),
        ),
        Index(
            "uq_file_primary",
            "tenant_id", text("COALESCE(team_id, 0)"), "owner_type", "owner_id", "kind",
            unique=True,
            postgresql_where=text("is_primary AND is_current"),
        ),
    )


class SubscriptionBundle(Base):
    """订阅套餐（subscription_bundles）。"""

    __tablename__ = "subscription_bundles"

    id = Column(BigInteger, primary_key=True)
    bundle_code = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    plan_codes = Column(ARRAY(Text), nullable=False)
    price_cny = Column(Numeric(10, 2), nullable=True)
    is_active = Column(Boolean, nullable=False, server_default=text("true"))
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=text("now()"))

    __table_args__ = (
        UniqueConstraint("bundle_code", name="uq_subscription_bundles_code"),
    )


class Subscription(Base):
    """租户订阅（subscriptions）。"""

    __tablename__ = "subscriptions"

    id = Column(BigInteger, primary_key=True)
    tenant_id = Column(Text, nullable=False)
    plan_code = Column(Text, nullable=False)
    plan_type = Column(Text, nullable=False, server_default=text("'single'::text"))
    bundle_code = Column(Text, nullable=True)
    status = Column(Text, nullable=False, server_default=text("'active'::text"))
    started_at = Column(DateTime(timezone=True), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=text("now()"))

    __table_args__ = (
        Index(
            "uq_subscriptions_tenant_plan_active",
            "tenant_id", "plan_code",
            unique=True,
            postgresql_where=text("status = 'active'::text"),
        ),
    )


class TradeDocFile(Base):
    """单证↔文件关联（trade_doc_files）。"""

    __tablename__ = "trade_doc_files"

    id = Column(BigInteger, primary_key=True)
    tenant_id = Column(Text, nullable=False)
    trade_doc_id = Column(BigInteger, nullable=False)
    file_id = Column(BigInteger, ForeignKey("file_objects.id"), nullable=False)
    role = Column(Text, nullable=False)
    caption = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, server_default=text("0"))
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=text("now()"))

    __table_args__ = (
        Index("idx_tdf_doc", "tenant_id", "trade_doc_id", "role"),
        Index("idx_tdf_file", "tenant_id", "file_id"),
    )


# product_profiles 生产库**没有主键**（唯一性靠函数唯一索引 uq_product_profiles_scope），
# ORM 类必须有主键，故用 Core Table 表达，保持 DDL 与生产一致。
product_profiles = Table(
    "product_profiles",
    Base.metadata,
    Column("tenant_id", Text, nullable=False),
    Column("product_key", Text, nullable=False),
    Column("info", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    Column("updated_by", Text, nullable=True),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    Column("team_id", BigInteger, ForeignKey("teams.id", ondelete="SET NULL"), nullable=True),
    Index(
        "uq_product_profiles_scope",
        "tenant_id", text("COALESCE(team_id, 0)"), "product_key",
        unique=True,
    ),
    Index("idx_product_profiles_team", "team_id"),
)


__all__ = [
    "EntityLink",
    "FeatureFlag",
    "FeatureFlagAudit",
    "FileObject",
    "Subscription",
    "SubscriptionBundle",
    "TradeDocFile",
    "product_profiles",
]
