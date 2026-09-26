"""Kaas v2 · 客户报价税率档案（「税务档案」下拉里的客户那一层）

业务口径
--------
报价页上那个「税务档案」下拉里现在装**两层**东西：

1. **法定税务档案**（平台维护的 yaml，如 CN-2026-09）—— 销项税率、印花税率、
   按 HS 编码的出口退税率。国家政策变一次就新增一份，谁也不去改它。
2. **客户税率档案**（本模块）—— 这个客户自己填的进项票税点、销项税率、
   出口退税率、印花税率 + 基数，存成一份命名档案，下次一键套用。

客户档案**必须记住它当时绑定的法定档案编号**。理由：两层放在同一个下拉里，
选中客户档案时法定档案也得跟着切过去；否则「客户档案 + 另一份法定档案」
会算出一个谁都没确认过的组合，而且金额看着完全正常。

档案不是一条新的算价路径
----------------------
套用档案做的事就是**把表单填好** —— 与用户手敲一遍的结果逐字段相同。
引擎收到的仍然是「rate_set_code + policy 覆盖」，一行都不用改。
这条设计很值钱：它意味着「用档案算出来的价」和「手填算出来的价」不可能分叉，
也不会绕过任何校验。

权限
----
- 客户/免费用户：只能读写自己的档案。
- 租户管理员：`?scope=all` 能看到本租户下**所有客户**的档案（便于排查谁还没配税率）。

安全约束
--------
- tenant/customer 永远从 AuthContext 取，不信任前端传入。
- tax_overrides 按**白名单**校验后入库：JSONB 没有数据库层约束，
  不校验就会让 `input_vat_rates`（多个 s）这类错键静默进库、永远读不出来。
- 停用是软删：档案一旦生成过报价单，删掉就无法回答「当时用的哪套税率」。
"""
from typing import Any, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth_context
from app.core.auth_utils import require_customer_match, require_tenant_match
from app.db.session import get_db_session
from app.deps.rbac import require_tenant_admin
from app.repositories.quote_profiles_repo import (
    create_profile,
    deactivate_profile,
    find_by_name,
    get_profile,
    list_profiles,
    update_profile,
)
from app.services.export_quote.products import get as get_product

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1", tags=["quote_profiles"])

# 允许存进档案的税率项 —— **白名单**，不是黑名单。
#
# 为什么必须是白名单：tax_overrides 是 JSONB，数据库不会拦任何键名。
# 若放行未知键，`input_vat_rates` / `stamp_ratex` 这类打错的键会安静地存进去，
# 界面上「保存成功」，下次应用时却什么都没带回 —— 用户看到的是
# 「存了但没生效」，而日志里一条错都没有。
#
# 刻意**不含**加工利润与让利比例：那是每单的商业决策，不是税率事实。
# 让档案把利润悄悄带回来，会报出一张没人确认过利润的价。
_ALLOWED_TAX_KEYS: dict[str, str] = {
    "input_vat_rate": "float",
    "output_vat_rate": "float",
    "rebate_rate": "float",
    "stamp_rate": "float",
    "stamp_base": "stamp_base",
}
_STAMP_BASES = {"profit", "cost", "base_quote"}


def _resolve_identity(request: Request, auth: AuthContext, body: Optional[dict] = None):
    """从 AuthContext 取 tenant/customer，并拒绝 body 里夹带的身份参数。"""
    if auth.is_customer():
        tenant_id: str = auth.tenant_id or ""
    else:
        tenant_id: str = getattr(request.state, "tenant_id", "") or ""
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Missing tenant context")

    customer_id: str = auth.customer_id_str or tenant_id
    if body is not None:
        require_tenant_match(auth, body.get("tenant_id"))
        require_customer_match(auth, body.get("customer_id"))
    return tenant_id, customer_id


def _validate_product(product_key: str) -> str:
    key = (product_key or "").strip()
    if not key:
        raise HTTPException(status_code=422, detail="product_key is required")
    try:
        get_product(key)
    except Exception:
        raise HTTPException(status_code=404, detail=f"未知产品: {key}")
    return key


def _clean_tax_overrides(raw: Any) -> dict[str, Any]:
    """按白名单清洗税率覆盖项，越界/打错一律 422，不静默丢弃。

    这里刻意「报错」而不是「忽略未知键」：用户把档案存下来就是为了以后能原样取回，
    悄悄丢掉一个键 = 以后取回的档案少一项，而界面不会说。
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise HTTPException(status_code=422, detail="tax_overrides must be an object")

    unknown = sorted(set(raw) - set(_ALLOWED_TAX_KEYS))
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"不支持的税率项: {', '.join(unknown)}（可用: {', '.join(sorted(_ALLOWED_TAX_KEYS))}）",
        )

    cleaned: dict[str, Any] = {}
    for key, kind in _ALLOWED_TAX_KEYS.items():
        if key not in raw:
            continue
        value = raw[key]
        if value is None or value == "":
            # 空 = 不覆盖，用法定值。不要存 null —— 取回时会变成「这条档案里有个 null」
            continue
        if kind == "stamp_base":
            text = str(value)
            if text not in _STAMP_BASES:
                raise HTTPException(
                    status_code=422,
                    detail=f"stamp_base 只能是 {', '.join(sorted(_STAMP_BASES))}",
                )
            cleaned[key] = text
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"{key} 必须是数字")
        # 税率是比例，必须落在 0~1。放行 10 这种「按百分数填」的值会让整张报价
        # 差一个数量级，而且不会报错。
        if not (0 <= number <= 1):
            raise HTTPException(status_code=422, detail=f"{key} 必须在 0~1 之间（10% 请填 0.1）")
        cleaned[key] = number
    return cleaned


def _serialize(profile) -> dict[str, Any]:
    """出参。产品显示名在这里解析，免得每个调用点都要自己补一遍。"""
    try:
        product_name = getattr(get_product(profile.product_key), "name", "")
    except Exception:
        # 产品可能被下线，但档案还在 —— 显示名缺失不该让整张列表读不出来
        product_name = ""
    return {
        "id": profile.id,
        "customer_id": profile.customer_id,
        "product_key": profile.product_key,
        "product_name": product_name,
        "profile_name": profile.profile_name,
        "rate_set_code": profile.rate_set_code,
        "tax_overrides": profile.tax_overrides or {},
        "source": profile.source,
        "created_at": profile.created_at.isoformat() if profile.created_at else None,
        "updated_at": profile.updated_at.isoformat() if profile.updated_at else None,
    }


@router.get("/quote-profiles", summary="客户报价税率档案（列表）")
async def list_quote_profiles(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """列出某产品下可用的客户税率档案。

    - 默认 `scope=own`：只返回当前客户自己的档案（界面下拉用这个）。
    - `scope=all`（需租户管理员）：返回本租户下所有客户的档案，按客户分组。
    """
    product_key = _validate_product(request.query_params.get("product_key") or "")
    scope = (request.query_params.get("scope") or "own").strip()
    if scope not in ("own", "all"):
        raise HTTPException(status_code=422, detail="scope must be own or all")

    tenant_id, customer_id = _resolve_identity(request, auth)

    if scope == "all":
        require_tenant_admin(request)
        rows = await list_profiles(db, tenant_id, product_key, customer_id=None)
        return {
            "scope": "all",
            "product_key": product_key,
            "profiles": [_serialize(p) for p in rows],
        }

    rows = await list_profiles(db, tenant_id, product_key, customer_id=customer_id)
    return {
        "scope": "own",
        "product_key": product_key,
        # 约定：按创建时间倒序。界面「默认选择最新创建的」取第一条即可，
        # 不要再自己在前端排一遍 —— 排序规则两处实现就会两处不一致。
        "profiles": [_serialize(p) for p in rows],
    }


@router.post("/quote-profiles", summary="保存一份税率档案", status_code=201)
async def create_quote_profile(
    request: Request,
    body: dict,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """把当前这套税率存成一份命名档案。"""
    tenant_id, customer_id = _resolve_identity(request, auth, body)

    product_key = _validate_product(body.get("product_key") or "")
    name = (body.get("profile_name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="profile_name is required")
    if len(name) > 60:
        raise HTTPException(status_code=422, detail="profile_name 过长（最多 60 字）")

    rate_set_code = (body.get("rate_set_code") or "").strip()
    if not rate_set_code:
        # 必须记住法定档案：两层在下拉里是一起选的，缺了它档案就不可复现
        raise HTTPException(status_code=422, detail="rate_set_code is required")

    tax_overrides = _clean_tax_overrides(body.get("tax_overrides"))
    if not tax_overrides:
        raise HTTPException(
            status_code=422,
            detail="这份档案里没有任何税率项 —— 空的档案套用后什么都不会变，请至少填一项",
        )

    if await find_by_name(db, tenant_id, customer_id, product_key, name):
        raise HTTPException(status_code=409, detail=f"已存在同名档案「{name}」，请换个名字")

    profile = await create_profile(
        db,
        tenant_id=tenant_id,
        customer_id=customer_id,
        product_key=product_key,
        profile_name=name,
        rate_set_code=rate_set_code,
        tax_overrides=tax_overrides,
        created_by=str(auth.user_id) if getattr(auth, "user_id", None) else None,
    )
    logger.info(
        "quote_profile_created",
        tenant_id=tenant_id,
        customer_id=customer_id,
        profile_id=profile.id,
        product_key=product_key,
        keys=sorted(tax_overrides),
    )
    return _serialize(profile)


@router.patch("/quote-profiles/{profile_id}", summary="改名 / 改内容")
async def patch_quote_profile(
    request: Request,
    profile_id: int,
    body: dict,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """改名或覆盖内容。只处理传进来的字段，未传的保持不动。"""
    tenant_id, customer_id = _resolve_identity(request, auth, body)
    profile = await get_profile(db, profile_id, tenant_id, customer_id=customer_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="档案不存在")

    new_name = body.get("profile_name")
    if new_name is not None:
        new_name = str(new_name).strip()
        if not new_name:
            raise HTTPException(status_code=422, detail="profile_name 不能为空")
        if await find_by_name(
            db, tenant_id, customer_id, profile.product_key, new_name, exclude_id=profile.id
        ):
            raise HTTPException(status_code=409, detail=f"已存在同名档案「{new_name}」")

    rate_set_code = body.get("rate_set_code")
    if rate_set_code is not None:
        rate_set_code = str(rate_set_code).strip()
        if not rate_set_code:
            raise HTTPException(status_code=422, detail="rate_set_code 不能为空")

    tax_overrides = (
        _clean_tax_overrides(body.get("tax_overrides"))
        if "tax_overrides" in body
        else None
    )
    if tax_overrides is not None and not tax_overrides:
        raise HTTPException(status_code=422, detail="至少保留一项税率，空的档案没有意义")

    await update_profile(
        db,
        profile,
        profile_name=new_name,
        rate_set_code=rate_set_code,
        tax_overrides=tax_overrides,
    )
    logger.info("quote_profile_updated", tenant_id=tenant_id, profile_id=profile.id)
    return _serialize(profile)


@router.delete("/quote-profiles/{profile_id}", summary="停用一份档案")
async def delete_quote_profile(
    request: Request,
    profile_id: int,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """停用（软删）。走「删除」而不是让用户改空 —— 用户想的就是从下拉里去掉它。"""
    tenant_id, customer_id = _resolve_identity(request, auth)
    profile = await get_profile(db, profile_id, tenant_id, customer_id=customer_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="档案不存在")

    await deactivate_profile(db, profile)
    logger.info("quote_profile_deactivated", tenant_id=tenant_id, profile_id=profile_id)
    return {"ok": True, "id": profile_id}
