"""企业主体信息 API（卖方抬头）—— WORKSTATION_DESIGN.md 单证连贯性缺口 G1

为什么需要它
------------
对外单证（发票/装箱单/合同/汇票…）的第一行必须是**卖方信头**：
公司英文名、英文地址、联系方式；PI/合同/汇票还要收款银行与 SWIFT。
原先全库只在注册流程存过公司名，导致每张单据的卖方抬头都是空白 ——
单据没有卖方抬头等同废纸，而且每次都要手工重填。

这里把「我方企业主体」做成租户级配置：保存一次，所有单据自动带入。

端点：
- GET  /api/v1/tenant/company-profile   读取（未配置时返回空结构而非 404，
                                         让前端表单可以直接绑定）
- PUT  /api/v1/tenant/company-profile   保存（按租户 upsert，一租户一份）
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.workstation_models import TenantCompanyProfile
from app.core.auth import AuthContext, get_auth_context
from app.api.ws_common import tenant_id_of

router = APIRouter(prefix="/api/v1", tags=["company-profile"])

# 对外单据的字段集合（供前端表单与单证渲染共用）
_FIELDS = (
    "name_en", "name_zh", "address_en", "address_zh",
    "phone", "email", "website",
    "bank_name", "bank_account", "swift_code", "logo_url",
    "default_incoterm", "default_payment_terms", "default_country_of_origin",
)


class CompanyProfileIn(BaseModel):
    """企业主体信息。仅 name_en 必填 —— 英文主体名是对外签约的唯一必要项，
    其余字段允许后补（不阻断用户先存下公司名）。"""
    name_en: str
    name_zh: Optional[str] = None
    address_en: Optional[str] = None
    address_zh: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    bank_name: Optional[str] = None
    bank_account: Optional[str] = None
    swift_code: Optional[str] = None
    logo_url: Optional[str] = None
    default_incoterm: Optional[str] = None
    default_payment_terms: Optional[str] = None
    default_country_of_origin: Optional[str] = None


def _empty() -> dict:
    return {field: None for field in _FIELDS}


def _to_dict(row: Optional[TenantCompanyProfile]) -> dict:
    if row is None:
        return {**_empty(), "configured": False}
    return {
        **{field: getattr(row, field) for field in _FIELDS},
        "configured": bool(row.name_en),
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def _load(db: AsyncSession, tenant_id: str) -> Optional[TenantCompanyProfile]:
    return (await db.execute(
        select(TenantCompanyProfile).where(TenantCompanyProfile.tenant_id == tenant_id)
    )).scalar_one_or_none()


def seller_block(profile: Optional[TenantCompanyProfile]) -> dict:
    """把企业主体信息转成单证渲染器认识的卖方区块。

    渲染器对卖方区块的字段名是固定的（company/address/phone/email/bank/account/swift），
    这里做一次显式映射，避免渲染层与数据库列名耦合。
    """
    if profile is None:
        return {}
    return {
        k: v for k, v in {
            "company": profile.name_en,
            "address": profile.address_en,
            "phone": profile.phone,
            "email": profile.email,
            "bank": profile.bank_name,
            "account": profile.bank_account,
            "swift": profile.swift_code,
        }.items() if v
    }


@router.get("/tenant/company-profile")
async def get_company_profile(
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    return _to_dict(await _load(db, tenant_id_of(auth)))


@router.put("/tenant/company-profile")
async def put_company_profile(
    body: CompanyProfileIn,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    if not body.name_en.strip():
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "NAME_EN_REQUIRED",
            "detail": "英文公司名必填（对外单据的卖方主体名）",
        })

    tenant_id = tenant_id_of(auth)
    row = await _load(db, tenant_id)
    if row is None:
        row = TenantCompanyProfile(tenant_id=tenant_id, name_en=body.name_en.strip())
        db.add(row)

    # 逐字段覆盖：允许把某个字段清空（用空串传），避免"填错了擦不掉"
    for field in _FIELDS:
        value = getattr(body, field, None)
        if field == "name_en":
            setattr(row, field, value.strip())
        elif value is not None:
            setattr(row, field, value)

    await db.commit()
    await db.refresh(row)
    return _to_dict(row)
