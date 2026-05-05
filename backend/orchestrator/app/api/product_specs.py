"""Kaas v2 · INT-R3 产品规格 API

GET /api/v1/product-specs — 前端动态表单读取规格选项。
"""
from fastapi import APIRouter, Request, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.db.session import get_db_session
from app.db.models import ProductSpec, CustomerCostItem, CustomerSalePriceItem

router = APIRouter(prefix="/api/v1", tags=["product_specs"])


@router.get("/product-specs")
async def list_product_specs(
    request: Request,
    product_category: str = Query(..., description="产品品类"),
    product_type: str = Query(None, description="产品类型（可选过滤）"),
    wire_diameter: str = Query(None, description="丝径（可选过滤）"),
    height: float = Query(None, description="高度/m（可选过滤）"),
    mesh_width: float = Query(None, description="网孔宽度/cm（可选过滤）"),
    mesh_spec: str = Query(None, description="网孔规格（可选过滤）"),
    roll_length: float = Query(None, description="卷长/m（可选过滤）"),
    quotable: bool = Query(False, description="仅返回有成本价/销售价的规格"),
    db: AsyncSession = Depends(get_db_session),
):
    """查询平台通用规格选项。

    返回规格选项和可选 accessory 选项。
    不返回任何成本、售价、利润、运费字段。
    所有 spec 参数为可选过滤 — 前端逐步选填时逐层过滤。

    当 quotable=True 时，额外返回 quotable_specs（完整规格组合列表），
    供前端做客户端联动过滤和精确 tuple 匹配校验。
    """
    stmt = select(ProductSpec).where(
        ProductSpec.product_category == product_category,
        ProductSpec.is_active == True,
    )

    quotable_hashes_subquery = None
    if quotable:
        tenant_id: str = getattr(request.state, "tenant_id", "")
        customer_id: str = request.headers.get("X-Customer-Id", "") or tenant_id
        if tenant_id and customer_id:
            from sqlalchemy import or_
            now = func.now()
            cost_hashes = select(CustomerCostItem.spec_hash).where(
                CustomerCostItem.tenant_id == tenant_id,
                CustomerCostItem.customer_id == customer_id,
                CustomerCostItem.product_category == product_category,
                CustomerCostItem.status == "active",
                CustomerCostItem.amount > 0,
                or_(
                    CustomerCostItem.effective_to.is_(None),
                    CustomerCostItem.effective_to >= now,
                ),
            )
            sale_hashes = select(CustomerSalePriceItem.spec_hash).where(
                CustomerSalePriceItem.tenant_id == tenant_id,
                CustomerSalePriceItem.customer_id == customer_id,
                CustomerSalePriceItem.product_category == product_category,
                CustomerSalePriceItem.status == "active",
                CustomerSalePriceItem.amount > 0,
                or_(
                    CustomerSalePriceItem.effective_to.is_(None),
                    CustomerSalePriceItem.effective_to >= now,
                ),
            )
            quotable_hashes_union = cost_hashes.union(sale_hashes).alias("quotable_hashes")
            quotable_hashes_subquery = select(quotable_hashes_union.c.spec_hash)
            stmt = stmt.where(ProductSpec.spec_hash.in_(quotable_hashes_subquery))

    if product_type:
        stmt = stmt.where(ProductSpec.product_type == product_type)
    if wire_diameter:
        stmt = stmt.where(ProductSpec.wire_diameter == wire_diameter)
    if height is not None:
        stmt = stmt.where(ProductSpec.height == height)
    if mesh_width is not None:
        stmt = stmt.where(ProductSpec.mesh_width == mesh_width)
    if mesh_spec:
        stmt = stmt.where(ProductSpec.mesh_spec == mesh_spec)
    if roll_length is not None:
        stmt = stmt.where(ProductSpec.roll_length == roll_length)

    result = await db.execute(stmt)
    specs = result.scalars().all()

    # Build option groups (filtered by current selections)
    product_types = sorted(set(s.product_type for s in specs if s.product_type))
    wire_diameters = sorted(set(s.wire_diameter for s in specs if s.wire_diameter))
    heights = sorted(set(s.height for s in specs if s.height))
    mesh_widths = sorted(set(s.mesh_width for s in specs if s.mesh_width))
    mesh_specs = sorted(set(s.mesh_spec for s in specs if s.mesh_spec))
    roll_lengths = sorted(set(s.roll_length for s in specs if s.roll_length))
    bundle_sizes = sorted(set(s.bundle_size for s in specs if s.bundle_size))

    # Build quotable_specs (unfiltered full combo list, for frontend tuple matching)
    quotable_specs: list[dict] = []
    if quotable and quotable_hashes_subquery is not None:
        all_quotable = await db.execute(
            select(ProductSpec).where(
                ProductSpec.product_category == product_category,
                ProductSpec.is_active == True,
                ProductSpec.spec_hash.in_(quotable_hashes_subquery),
            )
        )
        for s in all_quotable.scalars().all():
            quotable_specs.append({
                "product_type": s.product_type,
                "wire_diameter": s.wire_diameter,
                "height": s.height,
                "mesh_width": s.mesh_width,
                "mesh_spec": s.mesh_spec,
                "roll_length": s.roll_length,
            })

    # Accessory options (立柱/post type products)
    acc_stmt = select(ProductSpec).where(
        ProductSpec.product_category != product_category,
        ProductSpec.is_active == True,
    ).distinct(ProductSpec.product_category, ProductSpec.product_type)
    acc_result = await db.execute(acc_stmt)
    accessories = acc_result.scalars().all()

    # 当规格过滤至唯一匹配时返回 weight_kg
    weight_kg = specs[0].weight_kg if len(specs) == 1 else None

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
            "quotable_specs": quotable_specs,
            "accessory_categories": list(
                sorted(set(a.product_category for a in accessories))
            ),
            "weight_kg": weight_kg,
        },
    )
