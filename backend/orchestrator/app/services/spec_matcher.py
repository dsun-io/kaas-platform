"""Kaas v2 · INT-R3 规格匹配引擎 (§5 T2)

根据报价请求参数匹配 product_specs 表中唯一规格记录。
"""
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import ProductSpec
from app.repositories.product_specs_repo import match_specs


async def match_spec(
    db: AsyncSession,
    product_category: str,
    product_type: Optional[str] = None,
    wire_diameter: Optional[str] = None,
    height: Optional[float] = None,
    mesh_width: Optional[float] = None,
    mesh_spec: Optional[str] = None,
    roll_length: Optional[float] = None,
) -> dict:
    """匹配 product_specs 表平台通用规格。

    参数以 AND 条件精确过滤，仅查询 is_active=True 的记录。

    Returns:
        {
            "spec": ProductSpec | None,       # 唯一匹配到的规格对象
            "status": "matched"|"no_match"|"too_many",
            "notes": str,
        }
    """
    specs = await match_specs(
        db=db,
        product_category=product_category,
        product_type=product_type,
        wire_diameter=wire_diameter,
        height=height,
        mesh_width=mesh_width,
        mesh_spec=mesh_spec,
        roll_length=roll_length,
    )

    count = len(specs)

    if count == 0:
        return {
            "spec": None,
            "status": "no_match",
            "notes": f"未找到 {product_category} 匹配的规格记录",
        }

    if count == 1:
        return {
            "spec": specs[0],
            "status": "matched",
            "notes": f"已匹配规格: {_format_spec_summary(specs[0])}",
        }

    # count > 1
    return {
        "spec": None,
        "status": "too_many",
        "notes": f"找到 {count} 条匹配记录，请细化筛选条件",
    }


def _format_spec_summary(spec: ProductSpec) -> str:
    """生成 ProductSpec 的简短文字摘要。"""
    parts = [spec.product_category or ""]
    if spec.product_type:
        parts.append(spec.product_type)
    if spec.wire_diameter:
        parts.append(f"{spec.wire_diameter}丝径")
    if spec.height:
        parts.append(f"{spec.height}m高")
    if spec.mesh_width:
        parts.append(f"{spec.mesh_width}cm网宽")
    if spec.mesh_spec:
        parts.append(f"{spec.mesh_spec}网孔")
    if spec.roll_length:
        parts.append(f"{spec.roll_length}m长")
    return " | ".join(p for p in parts if p)
