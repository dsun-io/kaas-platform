"""税务档案（tax_archives）—— 团队级税率档案。

用户口径（2026-10-18 TAX-00 拍板）：
  · 档案是**团队级**（tenant_id + team_id），团队管理员写、成员读；
  · 字段 = 进项票税点 / 销项税率 / 出口退税率 / 杂税（综合税费系数，
    印花税已含在杂税里）；不含利润率/让利，不单列印花税；
  · 档案只负责在报价页“填表”，**不参与后端算价**：后端仍只认请求里的显式税率；
  · 版本/生效日期只用于展示和排序，不做报价日期门禁；
  · 历史靠报价单 `tax_snapshot` 复现。

为什么税率放 JSONB：与旧 `customer_quote_profiles.tax_overrides` 同模式，
以后加税种不用每次迁移；键名由 API 白名单校验，避免错键静默入库。
"""
from sqlalchemy import (
    BigInteger,
    Column,
    Date,
    DateTime,
    Index,
    Numeric,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

from app.db.base import Base


class ProductTaxRate(Base):
    """产品税率档案：一个团队 + 一个产品一条，维护进项税与出口退税率。"""
    __tablename__ = "product_tax_rates"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False, default="default")
    team_id = Column(BigInteger, nullable=False)
    product_key = Column(Text, nullable=False)
    input_vat_rate = Column(Numeric(8, 6), nullable=True)
    rebate_rate = Column(Numeric(8, 6), nullable=True)
    status = Column(Text, nullable=False, default="active")
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "team_id", "product_key",
            name="uq_product_tax_rates_team_product",
        ),
        Index(
            "idx_product_tax_rates_team",
            "tenant_id", "team_id", "status",
        ),
    )


class TaxArchive(Base):
    """企业级税务档案：只保留销项税率与杂税（进项/退税按产品走）。"""
    __tablename__ = "tax_archives"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False, default="default")
    team_id = Column(BigInteger, nullable=True)
    code = Column(Text, nullable=True)
    name = Column(Text, nullable=False)
    effective_from = Column(Date, nullable=True)
    effective_to = Column(Date, nullable=True)
    tax_values = Column(JSONB, nullable=False, default=dict)
    source = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="active")
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint("tenant_id", "team_id", "name", name="uq_tax_archives_team_name"),
        UniqueConstraint("tenant_id", "team_id", "code", name="uq_tax_archives_team_code"),
        Index(
            "idx_tax_archives_team_status",
            "tenant_id", "team_id", "status",
            "effective_from", "updated_at",
        ),
    )

