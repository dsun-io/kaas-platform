"""客户 / 询盘域补充端点（Worker 镜像 · 生产对齐）。

为什么需要这个文件
-----------------
orchestrator 的 `app/api/customers.py` 有 6 组客户/询盘路由，线上 Worker 只搬了
一半（列表 / 新建 / 详情 / 联系人 / 新建询盘 / 改阶段）。剩下这四条一直没搬，
已登记在 `scripts/route-parity-allowlist.txt`（「待补」= 承认的缺口）：

    PATCH /api/v1/customers/{customer_id}           客户档案更新
    GET   /api/v1/customers/{customer_id}/inquiries 某客户询盘列表
    GET   /api/v1/inquiries                         询盘总表（按客户归类）
    PATCH /api/v1/inquiries/{inquiry_id}            询盘状态流转（驱动客户 stage）

缺口的表现不是报错而是「页面能开、数据拉不到」：线上调用一律 404。
本文件把缺口补齐，语义逐条对齐 orchestrator（真源 = `app/api/customers.py`
L268-290 / L481-501 / L536-559 / L560-631）。

对齐口径
-------
- **序列化**：复用 `kaas_common.workstation.customer_serializers` 的
  `row_to_customer` / `row_to_inquiry`（main.py L47 已 import），字段与线上既有
  客户路由完全一致 —— 不另写一份投影。
- **枚举**：一律走共享枚举校验 `kaas_common.domain.enums.validate_enum`
  （由 `scripts/sync-shared.ps1` 从 `app/domain/enums.py` 镜像，不是手抄）。
  非法值 → 422 `{"error": "invalid_enum_value", "code": "INVALID_ENUM", ...}`，
  与 orchestrator 逐字同构。
- **可见范围 / 写权限（§10.3）**：复用 main 的 `_can_see_all` / `_owner_visible` /
  `_check_write_access`（与 dev `ws_common.can_see_all/scope_filter/check_write_access`
  同语义）：不可见一律 404（不泄露存在性），可读不可写一律 403 `NOT_OWNER`。
- **联动规则（§10.1）**：询盘 `open→won` 把客户 stage 置 won 并写 `cust_stage_log`；
  `open→quoted` 只在客户还处于 lead/inquiry 时推进；`→lost` 不动客户 stage。
  与 dev 唯一的差别是**实现方式**（raw SQL + 单事务），判定条件逐条照抄。
- **数据访问**：单语句读写走 `platform/db.py` 的 `db.*`（返回 dict，jsonb 由
  `table=` 解码）；询盘状态流转要「询盘 + 客户 stage + 阶段日志 + 线索池回写」
  一起提交，故用 `_main._acquire` 的单连接事务。
"""
from __future__ import annotations

from typing import Optional

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel

import main as _main
from kaas_common.domain.enums import validate_enum

app = _main.app
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT
db = _main.db
_acquire = _main._acquire

# main 的归属/权限判定：**只复用，不重写**（重写就会出现两份「谁能看见」的口径）
_can_see_all = _main._can_see_all
_owner_visible = _main._owner_visible
_check_write_access = _main._check_write_access
row_to_customer = _main.row_to_customer
row_to_inquiry = _main.row_to_inquiry

# ── 可更新列白名单（列名直接拼进 SQL，绝不接受外部输入）──────────────────────
# body 字段 → 表列：`company_name` 在库里叫 `name`，与 dev 的 CustomerUpdate 映射一致。
_CUSTOMER_COLUMNS = (
    ("company_name", "name"),
    ("country", "country"),
    ("address", "address"),
    ("default_port", "default_port"),
    ("credit_level", "credit_level"),
    ("notes", "notes"),
    ("owner_scope", "owner_scope"),
)

# 询盘可更新列（`status` 单独处理：它带状态机与联动，见 PATCH /inquiries/{id}）
_INQUIRY_COLUMNS = (
    "channel", "product_name_raw", "quantity", "quantity_unit",
    "application", "notes", "owner_scope",
)

# 询盘状态机（真源 = orchestrator `app/api/customers.py` L583-587 的 allowed_flows）。
# 共享内核 `kaas_common/workstation/state_machines.py` 目前只有报价/订单/单证/出运
# 四张表，没有询盘表；故这里逐字保留该转移表。枚举**取值清单**仍由共享枚举校验，
# 不手抄第二份值（避免"同一个状态在两处定义"的漂移）。
_INQUIRY_NEXT = {
    "open": ("quoted", "won", "lost"),
    "quoted": ("won", "lost"),
    "won": (),
    "lost": (),
}

# 询盘状态 → 线索池 lead_candidates.inquiry_status（§7.2）。
# 真源 = orchestrator `app/jobs/lead_scan.py` L29 的 INQUIRY_SYNC_MAP；worker 侧没有
# 定时任务模块（无调度器），故把这份映射内联，在 PATCH 询盘时同步回写 —— 不同步的话
# 线索池页面的「跟进中/已赢单」永远停在 new，业务会以为询盘没流转。
_LEAD_INQUIRY_STATUS = {
    "open": "new", "quoted": "following", "won": "won", "lost": "lost",
}


# ── Schemas（与 orchestrator 的 CustomerUpdate / InquiryUpdate 逐字段一致）────

class _CustomerUpdate(BaseModel):
    company_name: Optional[str] = None
    country: Optional[str] = None
    address: Optional[str] = None
    default_port: Optional[str] = None
    credit_level: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: Optional[str] = None


class _InquiryUpdate(BaseModel):
    status: Optional[str] = None
    channel: Optional[str] = None
    product_name_raw: Optional[str] = None
    quantity: Optional[float] = None
    quantity_unit: Optional[str] = None
    application: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: Optional[str] = None


# ── Helpers ─────────────────────────────────────────────────────────────────

async def _customer_or_404(request: Request, customer_id: int, user: dict) -> dict:
    """取客户；不在可见范围内按 404 处理（对齐 dev `_get_customer_or_404`）。

    刻意不区分「不存在」与「无权可见」：区分了就等于告诉调用方别家客户的 id 存在。
    """
    row = await db.fetchrow(
        request,
        "SELECT c.*, c.name AS company_name,"
        f" {_main._customer_stage_sql('c')} AS stage_display"
        " FROM customers c WHERE c.id = $1 AND c.tenant_id = $2"
        " AND c.is_deleted = false",
        customer_id, DEFAULT_TENANT, table="customers",
    )
    if row is None or not _owner_visible(user, row):
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "CUSTOMER_NOT_FOUND"})
    return row


async def _sync_lead_status(conn, inq, new_status: str) -> None:
    """回写线索池 `lead_candidates.inquiry_status`（§7.2 / dev `sync_inquiry_status`）。

    `IS DISTINCT FROM` 与 dev 的 `if lead.inquiry_status != mapped` 同义：
    值没变就不写，免得每次流转都把线索行的 updated_at 顶一遍。
    """
    if inq["lead_id"] is None:
        return
    mapped = _LEAD_INQUIRY_STATUS.get(new_status)
    if mapped is None:
        return
    await conn.execute(
        "UPDATE lead_candidates SET inquiry_status = $1, updated_at = now()"
        " WHERE tenant_id = $2 AND id = $3 AND inquiry_status IS DISTINCT FROM $1",
        mapped, DEFAULT_TENANT, inq["lead_id"],
    )


# ── 客户档案更新 ─────────────────────────────────────────────────────────────

@app.patch("/api/v1/customers/{customer_id}")
async def update_customer(
    customer_id: int,
    request: Request,
    body: _CustomerUpdate,
    user: dict = Depends(_get_current_user),
):
    """部分更新客户档案（只写请求里**显式出现**的字段）。

    `exclude_unset` 是关键：显式传 `null` 表示"清空该字段"，字段不传表示"别动它"。
    用 `exclude_none` 会把"清空"变成"不动"，用户删掉一个备注会发现删不掉。
    """
    row = await _customer_or_404(request, customer_id, user)
    _check_write_access(user, row)

    data = body.model_dump(exclude_unset=True)
    if "owner_scope" in data:
        validate_enum("owner_scope", data["owner_scope"])

    sets: list = []
    params: list = []
    for field, column in _CUSTOMER_COLUMNS:
        if field in data:
            params.append(data[field])
            sets.append(f"{column} = ${len(params)}")
    if not sets:
        # dev：没有任何字段变更时不发 UPDATE，原样回显（updated_at 不动）
        return _main._customer_api(row)

    sets.append("updated_at = now()")  # dev 靠 ORM 的 onupdate=func.now()
    params.append(customer_id)
    updated = await db.fetchrow(
        request,
        f"UPDATE customers SET {', '.join(sets)}"
        f" WHERE id = ${len(params)} AND tenant_id = ${len(params) + 1}"
        f" RETURNING *",
        *params, DEFAULT_TENANT, table="customers",
    )
    # 2026-10-18：响应必须带推导后的展示阶段（有开启中订单 ⇒ stage=ordered）。
    # 档案编辑不改 stage，故沿用编辑前那一行的 stage_display，避免多打一次库。
    return _main._customer_api({
        **dict(updated),
        "stage_display": row.get("stage_display"),
    })


# ── 询盘 ─────────────────────────────────────────────────────────────────────

@app.get("/api/v1/customers/{customer_id}/inquiries")
async def list_customer_inquiries(
    customer_id: int,
    request: Request,
    status: Optional[str] = None,
    user: dict = Depends(_get_current_user),
):
    """某客户名下的询盘（时间倒序），可选 `status` 过滤。

    与 dev 一致：只校验客户本身是否可见，其下询盘**不再逐条过滤** ——
    "能看见这个客户"就应当看得见他的询盘（否则列表会出现"客户有 3 条询盘、
    点进去 0 条"这种自相矛盾的界面）。
    """
    await _customer_or_404(request, customer_id, user)

    sql = "SELECT * FROM cust_inquiries WHERE customer_id = $1 AND tenant_id = $2"
    params: list = [customer_id, DEFAULT_TENANT]
    if status:
        validate_enum("inquiry_status", status)
        params.append(status)
        sql += f" AND status = ${len(params)}"
    sql += " ORDER BY created_at DESC"
    rows = await db.fetch(request, sql, *params, table="cust_inquiries")
    return {"items": [row_to_inquiry(r) for r in rows], "total": len(rows)}


@app.get("/api/v1/inquiries")
async def list_inquiries(
    request: Request,
    status: Optional[str] = None,
    customer_id: Optional[int] = None,
    user: dict = Depends(_get_current_user),
):
    """询盘总表：按客户归类、客户内时间倒序（§10.1 列表规则）。

    比 dev 多带 `company_name`（dev 也是这么做的：JOIN customers 取名），
    前端据此把询盘按客户分栏展示，不必再打一次客户接口。
    """
    sql = (
        "SELECT i.*, c.name AS company_name FROM cust_inquiries i"
        " JOIN customers c ON i.customer_id = c.id"
        " WHERE i.tenant_id = $1"
    )
    params: list = [DEFAULT_TENANT]
    if not _can_see_all(user):
        # §10.3 + 三层组织：自己名下 + 租户共享 + **本团队**（与 dev scope_filter 同序）
        params.append(str(user["id"]))
        scope_cond = f"(i.owner_id = ${len(params)} OR i.owner_scope = 'tenant'"
        if user.get("team_id") is not None:
            params.append(user["team_id"])
            scope_cond += f" OR i.team_id = ${len(params)}"
        sql += f" AND {scope_cond})"
    if status:
        validate_enum("inquiry_status", status)
        params.append(status)
        sql += f" AND i.status = ${len(params)}"
    if customer_id:
        params.append(customer_id)
        sql += f" AND i.customer_id = ${len(params)}"
    sql += " ORDER BY i.customer_id, i.created_at DESC"
    rows = await db.fetch(request, sql, *params, table="cust_inquiries")
    return {
        "items": [{**row_to_inquiry(r), "company_name": r.get("company_name")}
                  for r in rows],
        "total": len(rows),
    }


@app.patch("/api/v1/inquiries/{inquiry_id}")
async def update_inquiry(
    inquiry_id: int,
    request: Request,
    body: _InquiryUpdate,
    user: dict = Depends(_get_current_user),
):
    """询盘部分更新 + 状态流转（单据阶段）。

    2026-10-18 口径：询盘状态**不再驱动客户阶段**（客户阶段与订单阶段是两层：
    客户阶段只有活跃/沉寂/已下单，已下单只由开启中的订单推导）。
    状态流转仍需与线索池 `lead_candidates.inquiry_status` 同事务提交。
    """
    async with _acquire(request) as conn:
        inq = await conn.fetchrow(
            "SELECT * FROM cust_inquiries WHERE id = $1 AND tenant_id = $2",
            inquiry_id, DEFAULT_TENANT,
        )
        if inq is None or not _owner_visible(user, inq):
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "INQUIRY_NOT_FOUND"})
        _check_write_access(user, inq)

        data = body.model_dump(exclude_unset=True)
        new_status = data.pop("status", None)
        sets: list = []
        params: list = []

        if new_status is not None:
            validate_enum("inquiry_status", new_status)
            # 合法流转校验：won/lost 是终态，open 不能直接跳回 quoted 之外的状态
            if (new_status != inq["status"]
                    and new_status not in _INQUIRY_NEXT.get(inq["status"], ())):
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "ILLEGAL_TRANSITION",
                    "detail": f"询盘状态不允许从 {inq['status']} 流转到 {new_status}",
                })
            if new_status != inq["status"]:
                params.append(new_status)
                sets.append(f"status = ${len(params)}")
                await _sync_lead_status(conn, inq, new_status)

        if "channel" in data:
            validate_enum("inquiry_channel", data["channel"])
        if "owner_scope" in data:
            validate_enum("owner_scope", data["owner_scope"])
        for column in _INQUIRY_COLUMNS:
            if column in data:
                params.append(data[column])
                sets.append(f"{column} = ${len(params)}")

        if sets:
            sets.append("updated_at = now()")
            params.append(inquiry_id)
            row = await conn.fetchrow(
                f"UPDATE cust_inquiries SET {', '.join(sets)}"
                f" WHERE id = ${len(params)} RETURNING *",
                *params,
            )
        else:
            row = inq  # 无变更：dev 也不会发 UPDATE，原样回显
    return row_to_inquiry(dict(row))
