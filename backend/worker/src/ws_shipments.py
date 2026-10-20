"""自有出运台账（Worker 镜像 · 生产对齐）。

与 orchestrator 的 `app/api/shipments.py` 对齐，用 asyncpg 直连
（Worker 的 Hyperdrive 连接模式）。

为什么需要这个文件
------------------
前端 `/shipments` 页（`frontend/src/app/(app)/shipments/page.tsx`）会调
`GET/POST /api/v1/shipments` 与 `PATCH /api/v1/shipments/{id}`，而 worker 此前
只有 **intel 工位的** `/api/v1/intel/shipments`（海关情报货运记录，另一回事）。
线上打开出运台账页必然是 404 —— 这就是「本地有、线上没有」的典型漂移。

注意区别（§10.6 / §10.7）
-------------------------
- `intel_shipments`：海关情报里的**别家**货运记录。
- `shipments`（本模块）：**我们自己的**出运台账，客户名/收货人/货物做快照冗余，
  目标是查数据时能还原当时的具体情况。

对齐口径
--------
- 单租户 `DEFAULT_TENANT`；归属隔离 `owner_id` / `owner_scope` 与 dev 的
  `ws_common.scope_filter` / `check_write_access` 同语义（复用 main 里的助手）。
- 状态机 `SHIPMENT_NEXT` 来自**共享内核** `kaas_common.workstation.state_machines`
  （不再各自维护一份，否则会出现「本地能流转、线上 409」）。
- 枚举校验用共享内核 `kaas_common.domain.enums.validate_enum`（同一份常量表）。
- 取号走 main 的 `_next_doc_no`（`SHP-YYYYMM-0001`）。
- 出运后回写：建 `order_shipment_refs` 关联；订单 `producing → shipped`。

事务口径（与 orchestrator 的差异，仅此一处）
--------------------------------------------
orchestrator 用 ORM 会话，create 是**一个事务**（出运 + 关联 + 订单状态）。
Worker 的 `platform/db.py` 每次调用各开一条连接，所以 create 这里显式用
`_acquire` + `conn.transaction()` 保证三者原子 —— 否则会出现「出运建了、
关联没建」这种半截数据。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import Depends, HTTPException, Query, Request
from pydantic import BaseModel

from kaas_common.domain.enums import validate_enum
from kaas_common.workstation.state_machines import SHIPMENT_NEXT, can_transition

import main as _main
import inquiry_stage as _inquiry_stage

app = _main.app
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT
db = _main.db

# 与 orchestrator ShipmentCreate 字段一致（顺序也保持一致，便于对照）
_INSERT_COLUMNS = (
    "tenant_id", "shipment_no", "order_id", "customer_id", "customer_name",
    "consignee", "notify_party", "cargo_desc", "cargo_qty", "cargo_qty_unit",
    "cargo_weight_kg", "cargo_volume_cbm", "pol", "pod", "pol_name", "pod_name",
    "vessel", "voyage", "container_no", "so_no", "booking_no", "bl_no", "bl_type",
    "etd", "eta", "atd", "ata", "status", "freight_remark", "owner_id", "owner_scope",
    "team_id",
)

# PATCH 可改字段（与 orchestrator ShipmentPatch 的白名单一致）
_PATCH_TEXT_FIELDS = (
    "consignee", "notify_party", "cargo_desc", "bl_no", "vessel",
    "voyage", "container_no", "so_no", "booking_no", "freight_remark",
)
_PATCH_DATE_FIELDS = ("etd", "eta", "atd", "ata")


# ── Schemas ──────────────────────────────────────────────────────────────────

class ShipmentCreate(BaseModel):
    order_id: Optional[int] = None           # 关联订单（自动快照客户/货物 + 建关联）
    customer_id: Optional[int] = None
    consignee: Optional[str] = None
    notify_party: Optional[str] = None
    cargo_desc: Optional[str] = None
    cargo_qty: Optional[Decimal] = None
    cargo_qty_unit: Optional[str] = None
    cargo_weight_kg: Optional[Decimal] = None
    cargo_volume_cbm: Optional[Decimal] = None
    pol: Optional[str] = None
    pod: Optional[str] = None
    pol_name: Optional[str] = None
    pod_name: Optional[str] = None
    vessel: Optional[str] = None
    voyage: Optional[str] = None
    container_no: Optional[str] = None
    so_no: Optional[str] = None
    booking_no: Optional[str] = None
    bl_no: Optional[str] = None
    bl_type: Optional[str] = None            # original | telex | seaway
    etd: Optional[str] = None
    eta: Optional[str] = None
    atd: Optional[str] = None
    ata: Optional[str] = None
    freight_remark: Optional[str] = None
    owner_scope: str = "private"


class ShipmentPatch(BaseModel):
    consignee: Optional[str] = None
    notify_party: Optional[str] = None
    cargo_desc: Optional[str] = None
    bl_no: Optional[str] = None
    bl_type: Optional[str] = None
    etd: Optional[str] = None
    eta: Optional[str] = None
    atd: Optional[str] = None
    ata: Optional[str] = None
    vessel: Optional[str] = None
    voyage: Optional[str] = None
    container_no: Optional[str] = None
    so_no: Optional[str] = None
    booking_no: Optional[str] = None
    status: Optional[str] = None
    freight_remark: Optional[str] = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _parse_date(value: Optional[str]) -> Optional[date]:
    return date.fromisoformat(value) if value else None


def _f(value) -> Optional[float]:
    return float(value) if value is not None else None


def _row_to_shipment(s) -> dict:
    """行 → 输出（字段与 orchestrator `_row_to_shipment` 逐条对齐）。"""
    def d(v):
        return v.isoformat() if v else None
    return {
        "id": s["id"], "shipment_no": s["shipment_no"], "order_id": s["order_id"],
        "customer_id": s["customer_id"], "customer_name": s["customer_name"],
        "consignee": s["consignee"], "notify_party": s["notify_party"],
        "cargo_desc": s["cargo_desc"], "cargo_qty": _f(s["cargo_qty"]),
        "cargo_qty_unit": s["cargo_qty_unit"], "cargo_weight_kg": _f(s["cargo_weight_kg"]),
        "cargo_volume_cbm": _f(s["cargo_volume_cbm"]),
        "pol": s["pol"], "pod": s["pod"], "pol_name": s["pol_name"], "pod_name": s["pod_name"],
        "vessel": s["vessel"], "voyage": s["voyage"], "container_no": s["container_no"],
        "so_no": s["so_no"], "booking_no": s["booking_no"], "bl_no": s["bl_no"],
        "bl_type": s["bl_type"],
        "etd": d(s["etd"]), "eta": d(s["eta"]), "atd": d(s["atd"]), "ata": d(s["ata"]),
        "status": s["status"], "freight_remark": s["freight_remark"],
        "created_at": s["created_at"].isoformat() if s["created_at"] else None,
        "owner_id": s["owner_id"], "owner_scope": s["owner_scope"],
    }


async def _get_or_404(request, shipment_id: int, user: dict) -> dict:
    """取单条并做归属过滤 —— 不可见一律 404（与 dev scope_filter 的语义一致）。"""
    row = await db.fetchrow(
        request, "SELECT * FROM shipments WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, shipment_id, table="shipments",
    )
    if row is None or not _main._owner_visible(user, row):
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "SHIPMENT_NOT_FOUND",
        })
    return row


# ── 端点 ─────────────────────────────────────────────────────────────────────

@app.get("/api/v1/shipments")
async def list_shipments(
    request: Request,
    status: Optional[str] = None,
    order_id: Optional[int] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    user: dict = Depends(_get_current_user),
):
    """出运列表（分页 + status 筛选 + 归属可见范围）。"""
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    if status:
        validate_enum("shipment_status", status)     # 非法值 → 422
        params.append(status)
        where.append(f"status = ${len(params)}")
    if order_id:
        params.append(order_id)
        where.append(f"order_id = ${len(params)}")
    if not _main._can_see_all(user):
        params.append(str(user["id"]))
        scope_cond = f"(owner_id = ${len(params)} OR owner_scope = 'tenant'"
        # 三层组织：本团队可见（未分组的用户不加这段，行为与之前一致）
        if user.get("team_id") is not None:
            params.append(user["team_id"])
            scope_cond += f" OR team_id = ${len(params)}"
        where.append(scope_cond + ")")
    cond = " AND ".join(where)

    total = await db.fetchval(request, f"SELECT count(*) FROM shipments WHERE {cond}", *params)
    rows = await db.fetch(
        request,
        f"SELECT * FROM shipments WHERE {cond} ORDER BY created_at DESC, id DESC"
        f" LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}",
        *params, page_size, (page - 1) * page_size, table="shipments",
    )
    return {
        "items": [_row_to_shipment(s) for s in rows],
        "total": total, "page": page, "page_size": page_size,
    }


@app.post("/api/v1/shipments", status_code=201)
async def create_shipment(
    request: Request,
    body: ShipmentCreate,
    user: dict = Depends(_get_current_user),
):
    """新建出运：带 `order_id` 时自动快照客户/货物 + 建关联 + 回写订单状态。"""
    owner_scope = validate_enum("owner_scope", body.owner_scope) or "private"
    bl_type = validate_enum("bl_type", body.bl_type) if body.bl_type else None

    customer_name = None
    order = None
    cargo_desc, cargo_qty, cargo_qty_unit = body.cargo_desc, body.cargo_qty, body.cargo_qty_unit

    if body.order_id is not None:
        order = await db.fetchrow(
            request, "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, body.order_id, table="orders",
        )
        if order is None or not _main._owner_visible(user, order):
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "ORDER_NOT_FOUND",
            })
        _main._check_write_access(user, order)
        customer_name = order.get("customer_name")
        if cargo_desc is None or cargo_qty is None:
            # 货物快照：从订单行项汇总（未手动覆盖时）
            items = await db.fetch(
                request,
                "SELECT product_name, qty, qty_unit FROM order_items"
                " WHERE tenant_id=$1 AND order_id=$2 ORDER BY sort_order, id",
                DEFAULT_TENANT, order["id"], table="order_items",
            )
            if cargo_desc is None:
                names = [i["product_name"] for i in items if i.get("product_name")]
                cargo_desc = ", ".join(names) if names else None
            if cargo_qty is None:
                total_qty = sum(
                    (i["qty"] for i in items if i.get("qty") is not None), Decimal("0"))
                cargo_qty = total_qty if items else None
                if cargo_qty_unit is None and items:
                    cargo_qty_unit = items[0].get("qty_unit")

    customer = None
    customer_id = body.customer_id
    if order is not None and order.get("customer_id") is not None:
        customer_id = customer_id or order.get("customer_id")
    if customer_id is not None:
        customer = await db.fetchrow(
            request, "SELECT * FROM customers WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, customer_id, table="customers",
        )

    # 统一编号：类型-国家-客户-时间戳（与 orchestrator 同规则）
    async with _main._acquire(request) as conn:
        shipment_no = await _main._next_customer_doc_no(
            conn, "shipment", "shipments", customer or {}, "shipment_no")

    values = (
        DEFAULT_TENANT, shipment_no, body.order_id, body.customer_id, customer_name,
        body.consignee, body.notify_party, cargo_desc, cargo_qty, cargo_qty_unit,
        body.cargo_weight_kg, body.cargo_volume_cbm, body.pol, body.pod,
        body.pol_name, body.pod_name, body.vessel, body.voyage, body.container_no,
        body.so_no, body.booking_no, body.bl_no, bl_type,
        _parse_date(body.etd), _parse_date(body.eta),
        _parse_date(body.atd), _parse_date(body.ata),
        "booking", body.freight_remark, str(user["id"]), owner_scope,
        user.get("team_id"),
    )
    placeholders = ", ".join(f"${i}" for i in range(1, len(values) + 1))

    async with _main._acquire(request) as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                f"INSERT INTO shipments ({', '.join(_INSERT_COLUMNS)})"
                f" VALUES ({placeholders}) RETURNING *",
                *values,
            )
            if order is not None:
                # §10.6 回写：订单↔出运关联；producing → shipped
                await conn.execute(
                    "INSERT INTO order_shipment_refs (tenant_id, order_id, shipment_id, ref_type)"
                    " VALUES ($1,$2,$3,'actual_shipment')",
                    DEFAULT_TENANT, order["id"], row["id"],
                )
                if order.get("status") == "producing":
                    await conn.execute(
                        "UPDATE orders SET status='shipped', updated_at=now()"
                        " WHERE tenant_id=$1 AND id=$2",
                        DEFAULT_TENANT, order["id"],
                    )
                # 询盘阶段（TODO F4）：出运创建 → shipment（沿订单→报价→询盘传递）
                await _inquiry_stage.advance_for_order(
                    conn, tenant_id=DEFAULT_TENANT, order_id=order["id"],
                    target_stage=_inquiry_stage.STAGE_SHIPMENT,
                    source_event=_inquiry_stage.SOURCE_SHIPMENT_CREATED,
                    actor_id=str(user["id"]), quote_id=order.get("quote_id"),
                )
    return _row_to_shipment(row)


@app.get("/api/v1/shipments/{shipment_id}")
async def get_shipment(
    request: Request,
    shipment_id: int,
    user: dict = Depends(_get_current_user),
):
    return _row_to_shipment(await _get_or_404(request, shipment_id, user))


@app.patch("/api/v1/shipments/{shipment_id}")
async def update_shipment(
    request: Request,
    shipment_id: int,
    body: ShipmentPatch,
    user: dict = Depends(_get_current_user),
):
    """更新字段 / 状态流转（booking→in_transit→arrived→customs→delivered）。"""
    s = await _get_or_404(request, shipment_id, user)
    _main._check_write_access(user, s)

    sets: list[str] = []
    params: list = [DEFAULT_TENANT, shipment_id]
    for field in _PATCH_TEXT_FIELDS:
        value = getattr(body, field)
        if value is not None:
            params.append(value)
            sets.append(f"{field} = ${len(params)}")
    for field in _PATCH_DATE_FIELDS:
        value = getattr(body, field)
        if value is not None:
            params.append(_parse_date(value))
            sets.append(f"{field} = ${len(params)}")
    if body.bl_type is not None:
        params.append(validate_enum("bl_type", body.bl_type))
        sets.append(f"bl_type = ${len(params)}")

    if body.status is not None:
        target = validate_enum("shipment_status", body.status)
        if not can_transition("shipment", s["status"], target):
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "ILLEGAL_TRANSITION",
                "field": "status", "from": s["status"], "to": target,
                "allowed": list(SHIPMENT_NEXT.get(s["status"], ())),
            })
        params.append(target)
        sets.append(f"status = ${len(params)}")

    sets.append("updated_at = now()")
    row = await db.fetchrow(
        request,
        f"UPDATE shipments SET {', '.join(sets)}"
        f" WHERE tenant_id=$1 AND id=$2 RETURNING *",
        *params, table="shipments",
    )
    return _row_to_shipment(row)
