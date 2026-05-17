"""属性 API — /api/v1/spec/attributes"""
from fastapi import APIRouter, Depends, Request, Query
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.deps.rbac import require_tenant_viewer, require_tenant_admin
from app.repositories import attributes_repo
from app.services.attribute_similarity import find_similar_attributes

router = APIRouter(prefix="/api/v1/spec/attributes", tags=["spec-attributes"])


@router.get("")
async def list_attributes(
    scope: str | None = None,
    group_code: str | None = None,
    auth=Depends(require_tenant_viewer),
    db: AsyncSession = Depends(get_db_session),
):
    attrs = await attributes_repo.list_attributes(db, scope=scope, group_code=group_code)
    return {"items": [
        {"id": a.id, "code": a.code, "name": a.name, "data_type": a.data_type,
         "group_code": a.group_code, "scope": a.scope, "unit": a.unit}
        for a in attrs
    ]}


@router.get("/search")
async def search_attributes(
    q: str = Query(..., min_length=1),
    group_code: str = Query("spec"),
    auth=Depends(require_tenant_viewer),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = auth.tenant_id or ""
    # 需要 category_id，但搜索是跨类目的，传 0 表示不限
    results = await find_similar_attributes(db, q, tenant_id, 0, group_code)
    return {"items": [
        {"id": r.id, "code": r.code, "name": r.name, "scope": r.scope, "score": float(r.score)}
        for r in results
    ]}


@router.get("/{attribute_id}")
async def get_attribute(
    attribute_id: int,
    auth=Depends(require_tenant_viewer),
    db: AsyncSession = Depends(get_db_session),
):
    attr = await attributes_repo.get_attribute_by_id(db, attribute_id)
    if not attr:
        return {"error": "not_found"}
    tenant_id = auth.tenant_id or ""
    values = await attributes_repo.get_attribute_values(db, attr.id, tenant_id)
    return {
        "id": attr.id, "code": attr.code, "name": attr.name,
        "data_type": attr.data_type, "group_code": attr.group_code,
        "scope": attr.scope, "unit": attr.unit,
        "values": [{"id": v.id, "code": v.value_code, "label": v.value_label} for v in values],
    }


@router.post("")
async def create_attribute(
    request: Request,
    auth=Depends(require_tenant_admin),
    db: AsyncSession = Depends(get_db_session),
):
    body = await request.json()
    attr = await attributes_repo.create_attribute(
        db,
        code=body["code"],
        name=body["name"],
        group_code=body["group_code"],
        data_type=body["data_type"],
        scope=body.get("scope", "private"),
        tenant_id=auth.tenant_id,
        unit=body.get("unit"),
        unit_group=body.get("unit_group"),
        created_by=str(auth.user_id),
    )
    return {"id": attr.id, "code": attr.code}


@router.post("/{attribute_id}/values")
async def add_value(
    attribute_id: int,
    request: Request,
    auth=Depends(require_tenant_admin),
    db: AsyncSession = Depends(get_db_session),
):
    body = await request.json()
    val = await attributes_repo.create_attribute_value(
        db,
        attribute_id=attribute_id,
        value_code=body["code"],
        value_label=body["label"],
        scope=body.get("scope", "public"),
        tenant_id=auth.tenant_id,
    )
    return {"id": val.id, "code": val.value_code}
