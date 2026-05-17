"""模板 API — /api/v1/spec/templates"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.deps.rbac import require_tenant_viewer, require_tenant_admin
from app.repositories import templates_repo

router = APIRouter(prefix="/api/v1/spec/templates", tags=["spec-templates"])


@router.get("")
async def list_templates(
    auth=Depends(require_tenant_viewer),
    db: AsyncSession = Depends(get_db_session),
):
    templates = await templates_repo.get_templates(db)
    return {"items": [
        {"id": t.id, "code": t.code, "name": t.name, "template_type": t.template_type,
         "industry_code": t.industry_code, "usage_count": t.usage_count}
        for t in templates
    ]}


@router.get("/{template_id}")
async def get_template(
    template_id: int,
    auth=Depends(require_tenant_viewer),
    db: AsyncSession = Depends(get_db_session),
):
    t = await templates_repo.get_template_by_id(db, template_id)
    if not t:
        return {"error": "not_found"}
    return {
        "id": t.id, "code": t.code, "name": t.name,
        "snapshot": t.snapshot, "snapshot_version": t.snapshot_version,
    }
