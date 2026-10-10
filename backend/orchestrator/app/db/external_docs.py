"""外部单证上传：用户手动上传外部获取的单证（PDF/图片等）挂到对应订单，落库持久化。

与系统生成的单证同台账管理、同状态机（draft/issued/void），只是数据来源是「外部上传」
而非「报价/订单快照生成」。文件本体转 BYTEA 落库（单证多为 PDF/扫描件，量不大），
元数据（文件名/类型/大小/来源）单独存，便于检索与预览。
"""
from __future__ import annotations

from sqlalchemy import Column, BigInteger, Text, Numeric, DateTime, LargeBinary, Index, func
from sqlalchemy.dialects.postgresql import JSONB

from app.db.base import Base


class ExternalDocUpload(Base):
    __tablename__ = "external_doc_uploads"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    # 挂载对象：订单/报价单/询盘 任一（可空表示「未挂载」的散件）
    order_id = Column(BigInteger, nullable=True)
    quote_order_id = Column(BigInteger, nullable=True)
    inquiry_id = Column(BigInteger, nullable=True)
    customer_id = Column(Text, nullable=True)
    # 单证类型（与 trade_docs.doc_type 同枚举，便于与系统生成单证同台账展示）
    doc_type = Column(Text, nullable=True)
    file_name = Column(Text, nullable=False)
    content_type = Column(Text, nullable=True)
    file_size = Column(Numeric, nullable=True)
    # 文件本体（PDF/图片等二进制，转 PNG 与否由 API 层决定）
    content = Column(LargeBinary, nullable=False)
    # 状态：与 trade_docs 一致（draft/issued/void），外部单证默认 draft
    status = Column(Text, nullable=False, default="draft", server_default="draft")
    notes = Column(Text, nullable=True)
    uploaded_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_external_docs_tenant", "tenant_id", "doc_type", "status"),
        Index("idx_external_docs_order", "tenant_id", "order_id"),
    )
