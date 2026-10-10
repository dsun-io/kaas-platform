"""租户级产品定义 —— 运行时从数据库加载 ProductSpec（租户级优先，系统级兜底）。

加载优先级：
1. tenant_products 表（租户级，按 tenant_id + is_active 过滤）
2. products/ 目录的 Python 定义（系统级兜底）

权限矩阵（**未完成**）：
- is_system=true：系统级产品，所有租户可见，仅平台管理员可编辑
- is_system=false：租户级产品，仅本租户可见，租户管理员可编辑
详见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md
"""
from __future__ import annotations

from typing import Any, Optional

from ..models import ProductSpec, Axis, VariantGroup, FormulaSpec, Column, Invariant, SpaceDeduction


def spec_from_dict(data: dict) -> ProductSpec:
    """JSONB dict → ProductSpec（数据库加载用）。"""
    return ProductSpec(
        key=data["key"],
        name=data.get("name", ""),
        name_en=data.get("name_en", ""),
        category_code=data.get("category_code", ""),
        cost_field=data.get("cost_field", "raw_price"),
        cost_basis=data.get("cost_basis", "pretax"),
        cost_unit=data.get("cost_unit", ""),
        constants=data.get("constants") or {},
        axes=[Axis(**a) for a in data.get("axes") or []],
        variants=[VariantGroup(**v) for v in data.get("variants") or []],
        derived=[FormulaSpec(**f) for f in data.get("derived") or []],
        space_deduction=SpaceDeduction(**data["space_deduction"]) if data.get("space_deduction") else SpaceDeduction(),
        piece_metrics=[FormulaSpec(**f) for f in data.get("piece_metrics") or []],
        order_metrics=[FormulaSpec(**f) for f in data.get("order_metrics") or []],
        columns=[Column(**c) for c in data.get("columns") or []],
        invariants=[Invariant(**i) for i in data.get("invariants") or []],
        pricing_key=data.get("pricing_key") or [],
        notes=data.get("notes") or [],
        hs_codes=data.get("hs_codes") or [],
        profit_mode=data.get("profit_mode", "margin_on_price"),
        profit_value=data.get("profit_value", 0.06),
        misc_fee_rate=data.get("misc_fee_rate", 0.03),
    )


def spec_to_dict(spec: ProductSpec) -> dict:
    """ProductSpec → JSONB dict（数据库存储用）。"""
    from dataclasses import asdict
    return asdict(spec)


class TenantProductLoader:
    """租户级产品加载器：先查数据库，再回退 Python 定义。

    注意：**权限矩阵未完成**（is_system/is_active 只做基础过滤，
    未实现租户开通报价工位后的「选择启用产品」多对多关系）。
    """

    def __init__(self, db_session_factory=None):
        self._db = db_session_factory
        self._cache: dict[str, ProductSpec] = {}

    async def load(self, tenant_id: str, product_key: str) -> Optional[ProductSpec]:
        """加载产品定义：租户级优先，回退系统级 Python 定义。"""
        cache_key = f"{tenant_id}:{product_key}"
        if cache_key in self._cache:
            return self._cache[cache_key]

        # 1. 查 tenant_products 表
        if self._db is not None:
            row = await self._fetch_tenant_product(tenant_id, product_key)
            if row is not None:
                spec = spec_from_dict(row["spec"])
                self._cache[cache_key] = spec
                return spec

        # 2. 回退 Python 定义（系统级兜底）
        from ..products import get as get_product, has as has_product
        if has_product(product_key):
            spec = get_product(product_key)
            self._cache[cache_key] = spec
            return spec

        return None

    async def _fetch_tenant_product(self, tenant_id: str, product_key: str):
        from sqlalchemy import select
        from app.db.models import TenantProduct  # noqa: F401 - 延迟导入避免循环
        async with self._db() as session:
            result = await session.execute(
                select(TenantProduct).where(
                    TenantProduct.tenant_id == tenant_id,
                    TenantProduct.product_key == product_key,
                    TenantProduct.is_active == True,  # noqa: E712
                )
            )
            return result.scalar_one_or_none()

    def list_keys(self, tenant_id: str) -> list[str]:
        """列出该租户可用的产品 key（含系统级兜底）。"""
        from ..products import keys as product_keys
        return product_keys()
