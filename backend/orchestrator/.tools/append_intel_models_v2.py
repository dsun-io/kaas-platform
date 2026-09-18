"""Add remaining intel workstation tables to models.py"""
import sys

additional_models = '''

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
'''

path = 'd:/projects/kaas-platform/backend/orchestrator/app/db/models.py'
with open(path, 'a', encoding='utf-8') as f:
    f.write(additional_models)

print('Additional intel models appended to models.py')
