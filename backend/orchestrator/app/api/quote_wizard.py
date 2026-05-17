"""Wizard API — /api/v1/spec/wizard"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.deps.rbac import require_tenant_admin
from app.services.quote_wizard import submit_wizard
from app.repositories.proposals_repo import create_proposal
from app.schemas.quote_wizard import WizardSubmitRequest, WizardSubmitResponse, AttributeProposalRequest, AttributeProposalResponse

router = APIRouter(prefix="/api/v1/spec/wizard", tags=["spec-wizard"])


@router.post("/submit", response_model=WizardSubmitResponse)
async def wizard_submit(
    body: WizardSubmitRequest,
    auth=Depends(require_tenant_admin),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = auth.tenant_id or ""
    price_payload = None
    if body.pricing:
        price_payload = {
            "price": float(body.pricing.price),
            "price_unit": body.pricing.price_unit,
            "effective_from": body.pricing.effective_from,
            "effective_to": body.pricing.effective_to,
            "min_qty": float(body.pricing.min_qty) if body.pricing.min_qty else None,
            "tier_rules": body.pricing.tier_rules,
            "note": body.pricing.note,
            "change_reason": body.pricing.change_reason,
        }
    result = await submit_wizard(
        db=db,
        tenant_id=tenant_id,
        category_id=body.category_id,
        spec_values={k: v.model_dump() for k, v in body.spec_values.items()},
        price_payload=price_payload,
        weight_kg=float(body.weight_kg) if body.weight_kg else None,
        description=body.description,
        created_by=str(auth.user_id),
    )
    return WizardSubmitResponse(**result)


@router.post("/propose-attribute", response_model=AttributeProposalResponse)
async def propose_attribute(
    body: AttributeProposalRequest,
    auth=Depends(require_tenant_admin),
    db: AsyncSession = Depends(get_db_session),
):
    proposal = await create_proposal(
        db,
        tenant_id=auth.tenant_id or "",
        category_id=body.category_id,
        group_code=body.group_code,
        proposed_name=body.proposed_name,
        proposed_type=body.proposed_type,
        proposed_unit=body.proposed_unit,
        proposed_unit_group=body.proposed_unit_group,
        sample_values=body.sample_values,
        created_by=str(auth.user_id),
    )
    return AttributeProposalResponse(id=proposal.id, status=proposal.status)
