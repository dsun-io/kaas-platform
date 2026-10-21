"""询盘阶段状态机（TODO(TODO:F4)）——落库 + 事件驱动，前端展示推导作兜底。

口径（2026-10-20 用户拍板"落库+事件驱动"）：
- 阶段序：`inquiry`（询盘）< `quotation`（报价）< `order`（订单）< `shipment`（发货）
  < `completed`（完结）；`closed`（关闭）是**终态**，可从任意非终态进入。
- **只前进不后退**：事件重复触发是常态（重试 / 同询盘多张报价、多张订单），
  幂等靠"目标 rank ≤ 当前 rank 就 no-op"，不改任何行、不写日志。
- 每次**真实变更**写一条 `inquiry_stage_log`（谁 / 哪个事件 / 从哪到哪），
  报表与"历史变更可查"的验收都靠它。
- 订单本身不挂 `inquiry_id`（经报价传递：`quote_orders.inquiry_id`）——
  所以订单/出运事件要先沿 `orders.quote_id → quote_orders.inquiry_id` 找到询盘。

为什么不改 `cust_inquiries.status`：status 是"报价三态"（unquoted/quoted/closed，
前端与线索池同步都用它）。阶段是**业务流程进度**，两者语义不同：一张"已报价"的询盘
可能已经进到订单/发货阶段，status 仍是 quoted。把两件事塞进一列会让筛选与同步互相打架。
"""
from __future__ import annotations

from typing import Any, Optional

# 阶段常量（与迁移 202610200003 的回填/注释、前端展示共用同一组字符串）
STAGE_INQUIRY = "inquiry"
STAGE_QUOTATION = "quotation"
STAGE_ORDER = "order"
STAGE_SHIPMENT = "shipment"
STAGE_COMPLETED = "completed"
STAGE_CLOSED = "closed"

STAGE_SEQUENCE = (
    STAGE_INQUIRY, STAGE_QUOTATION, STAGE_ORDER, STAGE_SHIPMENT, STAGE_COMPLETED,
)
STAGE_RANK = {stage: index for index, stage in enumerate(STAGE_SEQUENCE)}
ALL_STAGES = (*STAGE_SEQUENCE, STAGE_CLOSED)

SOURCE_QUOTE_CREATED = "quote_created"
SOURCE_ORDER_CREATED = "order_created"
SOURCE_ORDER_COMPLETED = "order_completed"
SOURCE_SHIPMENT_CREATED = "shipment_created"
SOURCE_INQUIRY_CLOSED = "inquiry_closed"


def _get(row: Any, key: str, default: Any = None) -> Any:
    """asyncpg.Record 没有 .get()；假 db 的 dict 有 —— 两种都收（与其它模块同风格）。"""
    if row is None:
        return default
    if hasattr(row, "get"):
        return row.get(key, default)
    try:
        return row[key]
    except (KeyError, IndexError):
        return default


def current_stage_of(row: Any) -> str:
    """行的当前阶段；历史行没有 stage 列值时按 status 退化（closed→closed，其余→inquiry）。

    注意：`status` 与 `stage` 是**两层**语义（报价三态 vs 流程进度），退化只在
    "这一行没有 stage 值"时兜底，不会把 status 的 quoted 当成流程阶段。
    """
    stage = _get(row, "stage")
    if stage in ALL_STAGES:
        return stage
    return STAGE_CLOSED if _get(row, "status") == STAGE_CLOSED else STAGE_INQUIRY


async def advance(
    conn,
    *,
    tenant_id: str,
    inquiry_id: int,
    target_stage: str,
    source_event: str,
    actor_id: Optional[str] = None,
    note: Optional[str] = None,
    current_stage: Optional[str] = None,
    current_status: Optional[str] = None,
) -> Optional[dict]:
    """把询盘推进到 `target_stage`（只前进；closed 终态；重复事件 no-op）。

    `current_stage` / `current_status`：调用方**已经读过**询盘行时传进来，
    省掉一次 SELECT（报价创建路径在事务里刚查过，测试的假连接也不必多吐一行）。
    不传则自己 `SELECT ... FOR UPDATE` 再判定。

    返回 `{inquiry_id, from_stage, to_stage, changed, source_event}`；
    询盘不存在（或已被删）→ `None`（调用方的事务继续，不因"找不到询盘"炸掉业务动作）。
    """
    if target_stage not in ALL_STAGES:
        raise ValueError(f"unknown inquiry stage: {target_stage}")

    if current_status is not None:
        # 调用方已读过行：用已知 status 判定终态；stage 缺失（历史行）按 inquiry 退化
        current = current_stage if current_stage in ALL_STAGES else STAGE_INQUIRY
        if current != STAGE_CLOSED and current_status == STAGE_CLOSED:
            current = STAGE_CLOSED
    else:
        row = await conn.fetchrow(
            "SELECT stage, status FROM cust_inquiries"
            " WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            tenant_id, inquiry_id,
        )
        if row is None:
            return None
        current = current_stage_of(row)
    if current == STAGE_CLOSED:
        # 关闭是终态：任何后续事件都不再改阶段（要重开必须先人工改库/后续做 reopen）
        return {"inquiry_id": inquiry_id, "from_stage": current, "to_stage": current,
                "changed": False, "source_event": source_event}

    if target_stage == STAGE_CLOSED:
        target = STAGE_CLOSED
    elif STAGE_RANK.get(target_stage, -1) <= STAGE_RANK.get(current, -1):
        # 只前进：报价事件遇到已在订单/发货阶段的询盘 ⇒ 什么都不做（事件重试也安全）
        return {"inquiry_id": inquiry_id, "from_stage": current, "to_stage": current,
                "changed": False, "source_event": source_event}
    else:
        target = target_stage

    await conn.execute(
        "UPDATE cust_inquiries SET stage=$3, stage_updated_at=now(), updated_at=now()"
        " WHERE tenant_id=$1 AND id=$2",
        tenant_id, inquiry_id, target,
    )
    await conn.execute(
        "INSERT INTO inquiry_stage_log"
        " (tenant_id, inquiry_id, from_stage, to_stage, source_event, actor_id, note)"
        " VALUES ($1,$2,$3,$4,$5,$6,$7)",
        tenant_id, inquiry_id, current, target, source_event, actor_id, note,
    )
    return {"inquiry_id": inquiry_id, "from_stage": current, "to_stage": target,
            "changed": True, "source_event": source_event}


async def inquiry_id_of_order(conn, *, tenant_id: str, order_id: int,
                              quote_id: Any = None) -> Optional[int]:
    """订单 → 报价 → 询盘的传递链路（`orders.quote_id` 是唯一来源）。

    优先用调用方已拿到的 `quote_id`（少一次查询）；否则联表查。
    """
    if quote_id is not None:
        quote_row = await conn.fetchrow(
            "SELECT inquiry_id FROM quote_orders WHERE tenant_id=$1 AND id=$2",
            tenant_id, int(quote_id),
        )
        inquiry_id = _get(quote_row, "inquiry_id")
        if inquiry_id is not None:
            return int(inquiry_id)
    row = await conn.fetchrow(
        "SELECT q.inquiry_id FROM orders o"
        " JOIN quote_orders q ON q.tenant_id = o.tenant_id AND q.id = o.quote_id"
        " WHERE o.tenant_id=$1 AND o.id=$2",
        tenant_id, order_id,
    )
    inquiry_id = _get(row, "inquiry_id")
    return int(inquiry_id) if inquiry_id is not None else None


async def advance_for_order(
    conn,
    *,
    tenant_id: str,
    order_id: int,
    target_stage: str,
    source_event: str,
    actor_id: Optional[str] = None,
    quote_id: Any = None,
) -> Optional[dict]:
    """订单类事件（创建/完成/出运）→ 沿报价找到询盘 → 推进阶段。"""
    inquiry_id = await inquiry_id_of_order(
        conn, tenant_id=tenant_id, order_id=order_id, quote_id=quote_id)
    if inquiry_id is None:
        return None
    return await advance(
        conn, tenant_id=tenant_id, inquiry_id=inquiry_id,
        target_stage=target_stage, source_event=source_event, actor_id=actor_id,
    )
