"""订阅编码校验（最终设计 §9.1）

| 编码 | 包含 |
|---|---|
| leadgen_starter | 客户开发 + 线索池 |
| leadgen_pro | + 商情排序（预留） |
| outreach_starter | 客户触达 |
| outreach_pro | + 多邮箱 + AI 生成（预留） |
| intel_research_starter | 市场调研 |
| intel_full | 情报体系全套 |
| full_chain | 全工位 |

未订阅工位 API 返回 404。
"""
from functools import partial

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.workstation_models import TenantSubscription
from app.core.auth import AuthContext, get_auth_context
from app.api.ws_common import tenant_id_of

# 工位 → 可满足的订阅编码
WORKSTATION_CODES = {
    "leadgen": ("leadgen_starter", "leadgen_pro", "full_chain"),
    "outreach": ("outreach_starter", "outreach_pro", "full_chain"),
    # 市场调研：编码与线上 Worker chain.py 的 SUB_CODES["research"] 逐字对齐，
    # 两个运行时用同一张 tenant_subscriptions 表，写错编码会出现
    # 「线上能用、本地 404」的怪病。
    "research": ("intel_research_starter", "intel_full", "full_chain"),
}


async def require_subscription(
    workstation: str,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """FastAPI 依赖：校验租户订阅，未订阅抛 404（路由不存在语义）。"""
    tenant_id = tenant_id_of(auth)
    codes = WORKSTATION_CODES.get(workstation, ())
    if not codes:
        return auth
    row = (await db.execute(
        select(TenantSubscription).where(
            TenantSubscription.tenant_id == tenant_id,
            TenantSubscription.code.in_(codes),
            TenantSubscription.active == True,  # noqa: E712
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "SUBSCRIPTION_REQUIRED",
            "workstation": workstation, "required_any": list(codes),
            "detail": "未订阅该工位，请先开通对应订阅编码",
        })
    return auth


# 预绑定工位的依赖（FastAPI Depends 不透传 kwargs，用 partial 预绑定）
require_leadgen = partial(require_subscription, workstation="leadgen")
require_outreach = partial(require_subscription, workstation="outreach")
require_research = partial(require_subscription, workstation="research")
