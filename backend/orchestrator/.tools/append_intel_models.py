"""
Append intel workstation models to models.py
"""
import sys

intel_models = '''

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
'''

path = 'd:/projects/kaas-platform/backend/orchestrator/app/db/models.py'
with open(path, 'a', encoding='utf-8') as f:
    f.write(intel_models)

print('Intel models appended to models.py')
