"""品类 API — /api/v1/spec/categories"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.deps.rbac import require_tenant_viewer
from app.repositories import categories_repo
from app.repositories.attributes_repo import get_attributes_for_category, get_attribute_values

router = APIRouter(prefix="/api/v1/spec/categories", tags=["spec-categories"])


def _build_tree(flat: list, parent_id=None):
    nodes = []
    for cat in flat:
        if cat.parent_id == parent_id:
            node = {
                "id": cat.id, "code": cat.code, "name": cat.name,
                "parent_id": cat.parent_id, "path": cat.path, "level": cat.level,
                "industry_code": cat.industry_code, "is_leaf": cat.is_leaf, "is_active": cat.is_active,
                "children": _build_tree(flat, cat.id),
            }
            nodes.append(node)
    return nodes


@router.get("")
async def list_categories(
    auth=Depends(require_tenant_viewer),
    db: AsyncSession = Depends(get_db_session),
):
    cats = await categories_repo.get_category_tree(db)
    tree = _build_tree(cats)
    return {"items": tree}


@router.get("/{category_id}")
async def get_category(
    category_id: int,
    auth=Depends(require_tenant_viewer),
    db: AsyncSession = Depends(get_db_session),
):
    cat = await categories_repo.get_category_by_id(db, category_id)
    if not cat:
        return {"error": "not_found"}
    return {
        "id": cat.id, "code": cat.code, "name": cat.name,
        "parent_id": cat.parent_id, "path": cat.path, "level": cat.level,
        "industry_code": cat.industry_code, "is_leaf": cat.is_leaf,
    }


@router.get("/{category_id}/bindings")
async def get_bindings(
    category_id: int,
    auth=Depends(require_tenant_viewer),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = auth.tenant_id or ""
    rows = await get_attributes_for_category(db, category_id, tenant_id)
    result = []
    for binding, attr in rows:
        values = await get_attribute_values(db, attr.id, tenant_id)
        result.append({
            "binding_id": binding.id,
            "attr_role": binding.attr_role,
            "is_required": binding.is_required,
            "is_locked": binding.is_locked,
            "sort_order": binding.sort_order,
            "group_code": binding.group_code,
            "attribute": {
                "id": attr.id, "code": attr.code, "name": attr.name,
                "data_type": attr.data_type, "group_code": attr.group_code,
                "scope": attr.scope, "unit": attr.unit, "unit_group": attr.unit_group,
                "number_min": float(attr.number_min) if attr.number_min else None,
                "number_max": float(attr.number_max) if attr.number_max else None,
                "number_step": float(attr.number_step) if attr.number_step else None,
                "values": [{"id": v.id, "code": v.value_code, "label": v.value_label} for v in values],
            },
        })
    return {"items": result}
