"""业务客户往来记录（包含关系树）—— dev 端。

装配逻辑在共享内核 `kaas_common/workstation/customer_records.py`，**两端共用一份**；
契约见 `docs/CUSTOMER_DOCUMENTS_VIEW.md`，前端按同一契约解析
（`frontend/src/lib/customer/customer-records.ts`）。
"""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kaas_common.workstation.customer_records import build_records

from app.api.customers import _get_customer_or_404, _tenant_id
from app.core.auth import AuthContext, get_auth_context
from app.db.session import get_db_session
# 只用三张单据表的模型：归属只认列，不再查链接表
from app.db.workstation_links import Order, QuoteOrder, TradeDoc

router = APIRouter(prefix="/api/v1", tags=["customer-records"])


def _as_dict(row) -> dict:
    """ORM 行 → 普通 dict（装配内核只吃 dict / Mapping）。

    为什么在这里、而不是业务逻辑里：`build_records` 是"零 ORM 依赖"的共享内核
    （orchestrator 与 worker 共用一份），"把行摊平成 dict"是本适配层自己的事。

    2026-10-11 的 P3 重构（归属只认列、去掉链接表兜底，见
    docs/ENTITY_LINKS_OPTIMIZATION.md）把本函数连着 `_resolve_parents` 一起删了，
    但下面 4 处调用还在 —— 结果 `/records` 直接 500 `NameError: _as_dict`，
    客户往来记录树整条读路径不可用。这里按原样补回（纯适配，不做任何判定）。
    """
    return {c.name: getattr(row, c.name) for c in row.__table__.columns}


@router.get("/customers/{customer_id}/records")
async def customer_records(
    customer_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """某业务客户的往来记录：报价 → 报价单 / 订单 → 单证。

    - 不可见客户 → 404（复用客户详情的可见性判定，口径一致）
    - 其下的报价/订单/单证**不再单独按人过滤**：客户可见即整条业务链可见
      （与 worker 端同口径）；否则会出现"看得到客户却看不到他的单据"
    - **不按状态过滤**：草稿/已发出/已接受/已确认/作废全部返回
    - 手动新建 / 导入的、没有报价父对象的订单与单证 → `direct` 分组（用户要能查到历史）
    """
    tenant_id = _tenant_id(auth)
    customer = await _get_customer_or_404(db, tenant_id, customer_id, auth)

    quotes = (await db.execute(
        select(QuoteOrder).where(QuoteOrder.customer_id == customer_id)
        .order_by(QuoteOrder.created_at.desc()))).scalars().all()
    orders = (await db.execute(
        select(Order).where(Order.customer_id == customer_id)
        .order_by(Order.created_at))).scalars().all()
    docs = (await db.execute(
        select(TradeDoc).where(TradeDoc.customer_id == customer_id)
        .order_by(TradeDoc.created_at))).scalars().all()

    payload = _as_dict(customer)
    payload["id"] = customer_id
    order_rows = [_as_dict(r) for r in orders]
    doc_rows = [_as_dict(r) for r in docs]
    # 归属**只认列**（`orders.quote_id` / `trade_docs.quote_id`/`order_id`）：
    # 写入侧两端都写列，边表由数据库触发器从列自动派生 —— 真相只有一个，
    # 读侧不再需要"列优先、链接表兜底"那层兜底逻辑（见 docs/ENTITY_LINKS_OPTIMIZATION.md P3）。
    return build_records(payload, [_as_dict(r) for r in quotes], order_rows, doc_rows)
