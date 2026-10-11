"""团队级档位覆盖接口：查 / 改显示名 / 停用启用（#2b 的写侧）。

粒度是**团队**（2026-10-11 用户裁决）：档位 = 公司能做什么，不该因买家而异。
成本价相反，仍是买家客户级（在 `/pricing-data` 那套里），本文件不碰。

鉴权
----
**团队管理员（团队创建者）或平台管理员** —— 判定走共享内核
`kaas_common.workstation.teams.is_team_admin`，本文件**不另写一份判定**
（与 `workstations.py` 同一模式，含"先 404 后 403"的顺序：
不存在的团队不该因为调用者不是管理员而返回 403，那等于承认这个团队存在）。

接口
----
· `GET  /product-options/overrides?product_key=...` —— 列出该团队在该产品上的
  全部档位（**含已停用的**，并标注 `disabled` / `renamed`），供管理界面渲染。
· `PUT  /product-options/overrides` —— 增量改一个维度：
  `rename`（显示名，空串=取消改名）、`disable` / `enable`（软停用/恢复）。

两条硬约束（与 `services/option_overrides.py` 一致，此处只做接口不做新语义）：
  · **只改显示名，不改 code** —— code 是查价键的一半。
  · **停用是软停用** —— 从界面清单消失，但引擎仍能解析，历史报价单可重算。
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth_context
from app.db.models import Team
from app.db.session import get_db_session
from app.services.export_quote.models import apply_option_overrides
from app.services.export_quote.products import get as get_product
from app.services.option_overrides import (
    load_team_option_overrides,
    merge_override,
    save_team_option_overrides,
)

from kaas_common.workstation.teams import is_team_admin

router = APIRouter(prefix="/api/v1", tags=["option_overrides"])


class OptionOverrideIn(BaseModel):
    """改一个维度的档位（增量，不是整体覆盖）。"""

    product_key: str = Field(description="产品 key，如 field_fence")
    field: str = Field(description="维度字段，如 coating_code（变体包 code 字段）或 coating")
    rename: Optional[dict] = Field(
        default=None,
        description="显示名覆盖 {code: 新显示名}；值为空串表示**取消改名**。code 不变。",
    )
    disable: Optional[list] = Field(default=None, description="软停用的 code 列表")
    enable: Optional[list] = Field(default=None, description="恢复启用的 code 列表")


def _product_or_404(product_key: str):
    try:
        return get_product(product_key)
    except Exception:
        raise HTTPException(status_code=404, detail={"error": "unknown_product",
                                                     "product_key": product_key})


def _tenant_of(request: Request, auth: AuthContext) -> str:
    tenant_id = (auth.tenant_id or "") if auth.is_customer() else (
        getattr(request.state, "tenant_id", "") or "")
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Missing tenant context")
    return tenant_id


async def _require_team_admin(
    request: Request, db: AsyncSession, auth: AuthContext
) -> tuple[str, int]:
    """团队管理员（团队创建者）或平台管理员；返回 (tenant_id, team_id)。"""
    tenant_id = _tenant_of(request, auth)
    team_id = getattr(auth, "team_id", None)
    if not team_id:
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NO_TEAM",
            "message": "当前账号未归属团队，无法管理团队档位",
        })
    team = (
        await db.execute(
            select(Team).where(Team.tenant_id == tenant_id, Team.id == int(team_id))
        )
    ).scalars().first()
    # 顺序刻意是"先 404 后 403"：见模块 docstring
    if team is None:
        raise HTTPException(status_code=404, detail={"error": "team_not_found"})
    if not is_team_admin(team.created_by, auth.user_id, auth.role):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NOT_TEAM_ADMIN",
            "message": "仅团队管理员可管理本团队的档位",
        })
    return tenant_id, int(team_id)


@router.get("/product-options/overrides", summary="团队级档位（含已停用的）")
async def list_option_overrides(
    request: Request,
    product_key: str,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """列出该团队在该产品上的全部档位。

    返回**包含已停用**的档位并标注 `disabled` —— 管理界面要能把它们显示出来
    并支持"恢复"，所以不能只回可见的那部分。
    带 `code` 的同时也回当前的显示名（改名后是改名后的），
    以及 `is_default`（该显示名是否等于产品定义里的原值）。
    """
    product = _product_or_404(product_key)
    _, team_id = await _require_team_admin(request, db, auth)
    overrides = await load_team_option_overrides(db, team_id, product_key)

    # 先把覆盖套上：这样 label 反映的是**改名后的**显示名
    effective = apply_option_overrides(product, overrides)
    ov_map = overrides or {}

    fields = []
    for vg in effective.variants:
        ov = ov_map.get(f"{vg.name}_code") or ov_map.get(vg.name) or {}
        renamed = {str(k): str(v) for k, v in (ov.get("rename") or {}).items()}
        options = []
        for opt in vg.options:
            code = opt.get("code")
            ident = str(code if code is not None else opt.get("name"))
            options.append({
                "value": ident,
                "label": opt.get("name"),
                "label_en": opt.get("name_en") or "",
                "disabled": bool(opt.get("disabled")),
                "renamed": ident in renamed,
            })
        fields.append({
            "field": f"{vg.name}_code",
            "name": vg.name,
            "label": vg.label or vg.name,
            "options": options,
        })

    return {
        "product_key": product_key,
        "product_name": product.name,
        "team_id": team_id,
        "overrides": overrides,
        "fields": fields,
        "note": "停用只影响界面清单：引擎仍能解析已停用档位，历史报价单可重算。",
    }


@router.put("/product-options/overrides", summary="改显示名 / 软停用 / 恢复")
async def update_option_overrides(
    request: Request,
    body: OptionOverrideIn,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """增量改一个维度。

    - `rename`：`{code: 新显示名}`；值为空串 = **取消改名**（回到产品定义的写法）
    - `disable` / `enable`：软停用 / 恢复

    **code 不会被改**（它是查价键的一半），只改显示名。
    """
    product = _product_or_404(body.product_key)
    _, team_id = await _require_team_admin(request, db, auth)

    current = await load_team_option_overrides(db, team_id, body.product_key)
    merged = merge_override(
        current, body.field,
        rename=body.rename, disable=body.disable, enable=body.enable,
    )
    # 校验：改的必须是产品定义里**真的存在**的档位，否则是笔误，
    # 而且会在库里留下永远不生效的垃圾
    known = {
        str(o.get("code") if o.get("code") is not None else o.get("name"))
        for vg in product.variants for o in vg.options
    }
    if known:
        entry = merged.get(body.field) or {}
        unknown = [c for c in (entry.get("rename") or {}) if c not in known]
        unknown += [c for c in (entry.get("disabled") or []) if c not in known]
        if unknown:
            raise HTTPException(status_code=422, detail={
                "error": "unknown_option",
                "message": f"这些档位不在产品定义里：{', '.join(sorted(set(unknown)))}",
                "known": sorted(known),
            })

    saved = await save_team_option_overrides(db, team_id, body.product_key, merged)
    await db.commit()
    return {
        "product_key": body.product_key,
        "team_id": team_id,
        "overrides": saved,
        "note": "已保存。停用只影响界面清单，引擎仍能解析停用档位。",
    }
