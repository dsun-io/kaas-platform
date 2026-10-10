"""实际采购成本档案：产品 × 供应商(可选) × 生效期 的实际采购价。

**只用于利润核算，绝不进入报价计算链**：
报价用的是「报价成本」（pricing_key 定价表/内联成本），这张表存的是「实际采购成本」，
用于事后核算「报价售价 vs 实际成本」的真实利润。

口径：
- cost_basis：pretax（不含税，默认）| incl_tax（含税，按进项票税点换算税前值参与核算）
- unit_cost_actual / total_cost_actual：录入其一，另一个按 qty 自动换算
  （qty 来自客户订单中该行的产品数量）
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import Column, BigInteger, Text, Numeric, Date, DateTime, Boolean, Index, func

from app.db.base import Base


class ActualProcurementCost(Base):
    __tablename__ = "actual_procurement_costs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id = Column(Text, nullable=False)
    product_key = Column(Text, nullable=False)
    # 可选：按供应商区分（同一产品不同供方成本不同）
    supplier_name = Column(Text, nullable=True)
    # 生效期：开区间留空表示不限
    effective_from = Column(Date, nullable=True)
    effective_to = Column(Date, nullable=True)
    # 二选一录入，另一个按 qty 自动换算
    unit_cost_actual = Column(Numeric(20, 6), nullable=True)
    total_cost_actual = Column(Numeric(20, 6), nullable=True)
    # 记录录入时的数量口径，便于复现换算
    qty_snapshot = Column(Numeric(20, 6), nullable=True)
    qty_unit = Column(Text, nullable=True)
    # pretax | incl_tax
    cost_basis = Column(Text, nullable=False, default="pretax", server_default="pretax")
    # 含税录入时，换算税前值用的进项票税点（留痕，便于复现换算）
    input_vat_rate_snapshot = Column(Numeric(10, 6), nullable=True)
    currency = Column(Text, nullable=False, default="CNY", server_default="CNY")
    notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_apc_tenant_product", "tenant_id", "product_key"),
        Index("idx_apc_tenant_supplier", "tenant_id", "supplier_name"),
    )


def resolve_actual_unit_cost(
    row: ActualProcurementCost,
    qty: Decimal | None,
    input_vat_rate: Decimal | None = None,
) -> Decimal | None:
    """解析出税前单件实际成本（供利润核算用）。

    - 录了 unit_cost_actual → 直接用（含税口径则按 input_vat_rate 换算税前）
    - 只录了 total_cost_actual 且 qty > 0 → total / qty
    - 其余 → None（无法确定，交由调用方提示业务补录）
    """
    unit = row.unit_cost_actual
    if unit is None and row.total_cost_actual is not None and qty and qty > 0:
        unit = row.total_cost_actual / qty
    if unit is None:
        return None
    if row.cost_basis == "incl_tax":
        rate = row.input_vat_rate_snapshot or input_vat_rate
        if rate is not None and rate < 1:
            unit = unit * (Decimal(1) - rate)
    return unit
