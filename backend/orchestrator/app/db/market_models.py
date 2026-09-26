"""产品市场对照（market）工位数据模型。

这些表由迁移 `alembic/versions/20260919_customers_market_subs.py` 建好，
原先只有线上 Worker 用原生 SQL 访问（`backend/worker/src/main.py`）。
这里补上 orchestrator 侧的 ORM 声明 —— 列定义与迁移**逐字一致**。

为什么用 ORM 而不是继续写原生 SQL
--------------------------------
线上 Worker 侧踩过一个坑：`_row_to_dict(row)` 未登记表名时，jsonb 列会以
**字符串**下发（asyncpg 返回 str），前端拿到后直接 `.map()` 会崩。
用 ORM 声明 JSONB 列后由 SQLAlchemy 负责编解码，这类隐患自然消失。

注意：只声明本工位实际用到的表（`market_product_usage_mappings` 前端未用，先不建）。
"""
from sqlalchemy import (
    BigInteger, Boolean, Column, DateTime, Integer, Numeric, Text, func,
)
from sqlalchemy.dialects.postgresql import JSONB

from app.db.base import Base


class MarketRegionProduct(Base):
    """地区 × 产品对照：需求等级、认证要求、执行标准、季节规律。"""
    __tablename__ = "market_region_products"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    region_code = Column(Text, nullable=False)
    category_id = Column(BigInteger, nullable=True)
    demand_level = Column(Text, nullable=True)
    popularity_rank = Column(Integer, nullable=True)
    cert_requirements = Column(JSONB, nullable=True)
    standards = Column(JSONB, nullable=True)
    seasonality = Column(Text, nullable=True)
    source = Column(Text, nullable=False, server_default="manual")
    confidence = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False,
                        server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False,
                        server_default=func.now(), onupdate=func.now())


class MarketRegionProductSpec(Base):
    """某地区某产品的常用规格（含出现频次序）。"""
    __tablename__ = "market_region_product_specs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    market_product_id = Column(BigInteger, nullable=False)
    spec_key = Column(Text, nullable=False)
    spec_value = Column(Text, nullable=False)
    unit = Column(Text, nullable=True)
    frequency_rank = Column(Integer, nullable=True)
    sku_id = Column(BigInteger, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False,
                        server_default=func.now())


class MarketProductNameMapping(Base):
    """品名本地化对照：各地叫法、别名、HS 编码。"""
    __tablename__ = "market_product_name_mappings"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    category_id = Column(BigInteger, nullable=True)
    region_code = Column(Text, nullable=False)
    lang = Column(Text, nullable=False)
    local_name = Column(Text, nullable=False)
    alt_names = Column(JSONB, nullable=True)
    hs_code = Column(Text, nullable=True)
    source = Column(Text, nullable=False, server_default="manual")
    confidence = Column(Text, nullable=True)
    is_verified = Column(Boolean, nullable=False, server_default="false")
    created_at = Column(DateTime(timezone=True), nullable=False,
                        server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False,
                        server_default=func.now(), onupdate=func.now())


class MarketProductUsage(Base):
    """产品用途字典（围栏 / 防护 / 养殖 …）。"""
    __tablename__ = "market_product_usages"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    usage_code = Column(Text, nullable=False)
    usage_name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False,
                        server_default=func.now())


class MarketPort(Base):
    """港口档案（含经纬度与适装货类，供"最近港口"匹配用）。"""
    __tablename__ = "market_ports"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    name_cn = Column(Text, nullable=False)
    name_en = Column(Text, nullable=False)
    un_locode = Column(Text, nullable=True)
    country_code = Column(Text, nullable=False)
    city = Column(Text, nullable=True)
    lat = Column(Numeric(9, 6), nullable=True)
    lng = Column(Numeric(9, 6), nullable=True)
    port_type = Column(Text, nullable=True)
    position_desc = Column(Text, nullable=True)
    characteristics = Column(Text, nullable=True)
    berth_depth_m = Column(Numeric(6, 2), nullable=True)
    max_vessel_size = Column(Text, nullable=True)
    suitable_cargo = Column(JSONB, nullable=True)
    suitable_shipping_modes = Column(JSONB, nullable=True)
    connected_corridors = Column(JSONB, nullable=True)
    throughput_rank = Column(Integer, nullable=True)
    congestion_level = Column(Text, nullable=True)
    major_carriers = Column(JSONB, nullable=True)
    avg_dwell_days = Column(Numeric(4, 1), nullable=True)
    port_charges_level = Column(Text, nullable=True)
    last_verified_at = Column(DateTime(timezone=True), nullable=True)
    source = Column(Text, nullable=False, server_default="manual")
