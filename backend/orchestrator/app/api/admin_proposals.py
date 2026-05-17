"""Admin 属性提案 API — /api/v1/admin/spec/attribute-proposals"""
from fastapi import APIRouter, Depends, Request, Query
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.deps.rbac import require_platform_ops
from app.repositories import proposals_repo
from app.db.models import SpecAttribute

router = APIRouter(prefix="/api/v1/admin/spec/attribute-proposals", tags=["admin-proposals"])


@router.get("")
async def list_proposals(
    status: str | None = None,
    auth=Depends(require_platform_ops),
    db: AsyncSession = Depends(get_db_session),
):
    proposals = await proposals_repo.list_proposals(db, status=status)
    return {"items": [
        {
            "id": p.id, "tenant_id": p.tenant_id, "category_id": p.category_id,
            "proposed_name": p.proposed_name, "proposed_type": p.proposed_type,
            "group_code": p.group_code, "status": p.status,
            "occurrence_count": p.occurrence_count,
            "recommended_for_promotion": p.recommended_for_promotion,
            "recommendation_score": float(p.recommendation_score) if p.recommendation_score else None,
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p in proposals
    ]}


@router.get("/recommended")
async def list_recommended(
    auth=Depends(require_platform_ops),
    db: AsyncSession = Depends(get_db_session),
):
    proposals = await proposals_repo.list_recommended(db)
    return {"items": [
        {
            "id": p.id, "tenant_id": p.tenant_id, "proposed_name": p.proposed_name,
            "recommendation_score": float(p.recommendation_score) if p.recommendation_score else None,
            "recommended_at": p.recommended_at.isoformat() if p.recommended_at else None,
        }
        for p in proposals
    ]}


@router.patch("/{proposal_id}")
async def review_proposal(
    proposal_id: int,
    request: Request,
    auth=Depends(require_platform_ops),
    db: AsyncSession = Depends(get_db_session),
):
    body = await request.json()
    action = body.get("action")  # approve / reject / merge
    review_note = body.get("note")

    proposal = await proposals_repo.get_proposal_by_id(db, proposal_id)
    if not proposal:
        return {"error": "not_found"}

    if action == "approve":
        # 晋升: 创建公库属性
        new_attr = SpecAttribute(
            code=body.get("code", proposal.proposed_name.lower().replace(" ", "_")),
            name=proposal.proposed_name,
            group_code=proposal.group_code,
            data_type=proposal.proposed_type,
            unit=proposal.proposed_unit,
            unit_group=proposal.proposed_unit_group,
            scope="public",
            source="promoted",
            promoted_from=proposal.private_attribute_id,
            created_by=str(auth.user_id),
        )
        db.add(new_attr)
        await db.flush()
        await proposals_repo.update_proposal_status(db, proposal_id, "promoted", str(auth.user_id), review_note)
        proposal.promoted_attribute_id = new_attr.id
        await db.flush()
        return {"id": proposal_id, "status": "promoted", "promoted_attribute_id": new_attr.id}

    elif action == "reject":
        await proposals_repo.update_proposal_status(db, proposal_id, "rejected", str(auth.user_id), review_note)
        return {"id": proposal_id, "status": "rejected"}

    elif action == "merge":
        target_id = body.get("target_attribute_id")
        if not target_id:
            return {"error": "target_attribute_id required for merge"}
        await proposals_repo.update_proposal_status(db, proposal_id, "merged", str(auth.user_id), review_note)
        proposal.promoted_attribute_id = target_id
        await db.flush()
        return {"id": proposal_id, "status": "merged", "merged_into": target_id}

    return {"error": "invalid_action"}
