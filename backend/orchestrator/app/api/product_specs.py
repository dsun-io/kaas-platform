"""Kaas v2 · INT-R3 产品规格 API

GET /api/v1/product-specs — 前端动态表单读取规格选项。
"""
from fastapi import APIRouter, Request, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.db.session import get_db_session
from app.db.models import ProductSpec

router = APIRouter(prefix="/api/v1", tags=["product_specs"])


@router.get("/product-specs")
async def list_product_specs(
    request: Request,
    product_category: str = Query(..., description="产品品类"),
    product_type: str = Query(None, description="产品类型（可选过滤）"),
    db: AsyncSession = Depends(get_db_session),
):
    """查询平台通用规格选项。

    返回规格选项和可选 accessory 选项。
    不返回任何成本、售价、利润、运费字段。
    """
    stmt = select(ProductSpec).where(
        ProductSpec.product_category == product_category,
        ProductSpec.is_active == True,
    )
    if product_type:
        stmt = stmt.where(ProductSpec.product_type == product_type)

    result = await db.execute(stmt)
    specs = result.scalars().all()

    # Build option groups
    product_types = sorted(set(s.product_type for s in specs if s.product_type))
    wire_diameters = sorted(set(s.wire_diameter for s in specs if s.wire_diameter))
    heights = sorted(set(s.height for s in specs if s.height))
    mesh_widths = sorted(set(s.mesh_width for s in specs if s.mesh_width))
    mesh_specs = sorted(set(s.mesh_spec for s in specs if s.mesh_spec))
    roll_lengths = sorted(set(s.roll_length for s in specs if s.roll_length))
    bundle_sizes = sorted(set(s.bundle_size for s in specs if s.bundle_size))

    # Accessory options (立柱/post type products)
    acc_stmt = select(ProductSpec).where(
        ProductSpec.product_category != product_category,
        ProductSpec.is_active == True,
    ).distinct(ProductSpec.product_category, ProductSpec.product_type)
    acc_result = await db.execute(acc_stmt)
    accessories = acc_result.scalars().all()

    return JSONResponse(
        status_code=200,
        content={
            "product_category": product_category,
            "options": {
                "product_types": product_types,
                "wire_diameters": wire_diameters,
                "heights": heights,
                "mesh_widths": mesh_widths,
                "mesh_specs": mesh_specs,
                "roll_lengths": roll_lengths,
                "bundle_sizes": bundle_sizes,
            },
            "accessory_categories": list(
                sorted(set(a.product_category for a in accessories))
            ),
        },
    )
