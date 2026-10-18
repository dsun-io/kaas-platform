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
from app.db.models import Team
from app.db.workstation_models import TenantCompanyProfile
from app.core.auth import AuthContext, get_auth_context
from app.api.ws_common import tenant_id_of
from kaas_common.trade_doc.payload_shared import seller_block as _seller_block_shared
from kaas_common.workstation.scope import is_admin_role
from kaas_common.workstation.teams import is_team_admin

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


async def require_team_admin(db: AsyncSession, auth: AuthContext) -> None:
    """企业抬头/公章写入权限：**团队管理员或平台管理员**。

    用户 2026-10-18 明确：企业抬头只能团队管理员来改（成员可读）。
    平台管理员作为运维兜底；没有团队的账号（如纯客户账号）一律 403。
    """
    if is_admin_role(auth.role):
        return
    if auth.team_id is None:
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "TEAM_ADMIN_REQUIRED",
            "detail": "仅团队管理员可修改企业抬头/收款信息/公章",
        })
    created_by = (await db.execute(
        select(Team.created_by).where(Team.id == auth.team_id)
    )).scalar_one_or_none()
    if not is_team_admin(created_by, auth.user_id, auth.role):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "TEAM_ADMIN_REQUIRED",
            "detail": "仅团队管理员可修改企业抬头/收款信息/公章",
        })


def seller_block(profile: Optional[TenantCompanyProfile]) -> dict:
    """把企业主体信息转成单证渲染器认识的卖方区块。

    真源已上收到共享内核 `kaas_common/trade_doc/payload_shared.py`（2026-10-10）：
    Worker 的单证装配（`backend/worker/src/doc_payload.py`）必须用**同一份**映射，
    否则改了字段名只有一端生效（「本地抬头对了、线上还是旧字段」）。
    这里保留同名函数只是为了让既有 import（trade_docs.py）不动。
    """
    return _seller_block_shared(profile)


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
    # 权限：团队管理员（或平台管理员）才能改企业抬头
    await require_team_admin(db, auth)

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
