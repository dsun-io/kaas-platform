"""客户 / 询盘域补充端点（Worker 镜像 · 生产对齐）。

为什么需要这个文件（历史背景）
-----------------
方案 B 收敛前，客户/询盘域只存在于 orchestrator 业务壳；线上 Worker 只搬了一半
（列表 / 新建 / 详情 / 联系人 / 新建询盘 / 改阶段），剩下这四条一直没搬：

    PATCH /api/v1/customers/{customer_id}           客户档案更新
    GET   /api/v1/customers/{customer_id}/inquiries 某客户询盘列表
    GET   /api/v1/inquiries                         询盘总表（按客户归类）
    PATCH /api/v1/inquiries/{inquiry_id}            询盘状态流转（驱动客户 stage）

缺口的表现不是报错而是「页面能开、数据拉不到」：线上调用一律 404。
本文件把缺口补齐（业务壳已删，历史行号仅供参考；当前真源 = 共享内核
`kaas_common/` + 本 Worker 路由）。

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
import inquiry_stage as _inquiry_stage
from kaas_common.domain.enums import validate_enum
from kaas_common.workstation.number_rules import NumberError, normalize_number

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
    ("abbr", "abbr"),
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
    "unquoted": ("closed",),
    "quoted": ("closed",),
    "closed": ("unquoted", "quoted"),
}

# 询盘状态 → 线索池 lead_candidates.inquiry_status（§7.2）。
# 真源 = orchestrator `app/jobs/lead_scan.py` L29 的 INQUIRY_SYNC_MAP；worker 侧没有
# 定时任务模块（无调度器），故把这份映射内联，在 PATCH 询盘时同步回写 —— 不同步的话
# 线索池页面的「跟进中/已赢单」永远停在 new，业务会以为询盘没流转。
_LEAD_INQUIRY_STATUS = {
    "unquoted": "new", "quoted": "following", "closed": "lost",
}


# ── Schemas（与 orchestrator 的 CustomerUpdate / InquiryUpdate 逐字段一致）────

class _CustomerUpdate(BaseModel):
    company_name: Optional[str] = None
    abbr: Optional[str] = None
    country: Optional[str] = None
    address: Optional[str] = None
    default_port: Optional[str] = None
    credit_level: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: Optional[str] = None


class _InquiryUpdate(BaseModel):
    status: Optional[str] = None
    # 编号可改，但仅限「还没生成报价」时
    inquiry_no: Optional[str] = None
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
    if "abbr" in data:
        data["abbr"] = _main._norm_abbr(data["abbr"])

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

    ⚠️ PARITY-CRM-23（**有意差异，2026-10-19 裁决保留**）：每项比 orchestrator
    多一个 `inquiry_no_editable`。前端客户页的询盘清单用它决定「编号」是否
    可编辑（`frontend/src/app/(app)/customers/page.tsx` 的 `Inquiry.inquiry_no_editable`
    + 编号编辑按钮，消费处 page.tsx:1060）。删掉这个键会让已报价询盘也能改号，
    破坏报价链路 —— 故保留，并在 `tests/test_parity_crm.py` 里以普通用例
    写明"有意差异"，不留在 xfail 棘轮里。
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
    items = []
    for r in rows:
        item = row_to_inquiry(r)
        has_quote = await db.fetchval(
            request,
            "SELECT 1 FROM quote_orders WHERE tenant_id=$1 AND inquiry_id=$2 LIMIT 1",
            DEFAULT_TENANT, r["id"],
        )
        item["inquiry_no_editable"] = not bool(has_quote)
        items.append(item)
    return {"items": items, "total": len(rows)}


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
        new_no = data.pop("inquiry_no", None)
        sets: list = []
        params: list = []

        if new_no is not None and new_no != inq.get("inquiry_no"):
            try:
                new_no = normalize_number(new_no)
            except NumberError as exc:
                raise HTTPException(status_code=422, detail={
                    "error": "validation", "code": "INVALID_INQUIRY_NO",
                    "detail": str(exc),
                })
            has_quote = await conn.fetchval(
                "SELECT 1 FROM quote_orders WHERE tenant_id=$1 AND inquiry_id=$2 LIMIT 1",
                DEFAULT_TENANT, inquiry_id,
            )
            if has_quote:
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "INQUIRY_NO_LOCKED",
                    "detail": "该询盘已生成报价单，编号已锁定；如需改号请先处理关联报价",
                })
            taken = await conn.fetchval(
                "SELECT 1 FROM cust_inquiries WHERE tenant_id=$1"
                " AND inquiry_no=$2 AND id<>$3 LIMIT 1",
                DEFAULT_TENANT, new_no, inquiry_id,
            )
            if taken:
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "INQUIRY_NO_TAKEN",
                    "detail": f"询盘编号「{new_no}」已被占用，请换一个",
                })
            inq = {**inq, "inquiry_no": new_no}
            params.append(new_no)
            sets.append(f"inquiry_no = ${len(params)}")

        if new_status is not None:
            validate_enum("inquiry_status", new_status)
            # 三态流转：只有「关闭」是手动动作；关闭后重开若已有报价则回到已报价
            target = new_status
            if new_status == "unquoted":
                has_quote = await conn.fetchval(
                    "SELECT 1 FROM quote_orders WHERE tenant_id=$1 AND inquiry_id=$2 LIMIT 1",
                    DEFAULT_TENANT, inquiry_id,
                )
                if has_quote:
                    target = "quoted"
            if (target != inq["status"]
                    and target not in _INQUIRY_NEXT.get(inq["status"], ())):
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "ILLEGAL_TRANSITION",
                    "detail": f"询盘状态不允许从 {inq['status']} 流转到 {target}",
                })
            if target != inq["status"]:
                params.append(target)
                sets.append(f"status = ${len(params)}")
                await _sync_lead_status(conn, inq, target)

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
        # 询盘阶段（TODO(TODO:F4)）：手动关闭 → closed（终态；重开不回收 stage，只回状态）
        if new_status == "closed" and inq.get("status") != "closed":
            await _inquiry_stage.advance(
                conn, tenant_id=DEFAULT_TENANT, inquiry_id=inquiry_id,
                target_stage=_inquiry_stage.STAGE_CLOSED,
                source_event=_inquiry_stage.SOURCE_INQUIRY_CLOSED,
                actor_id=str(user["id"]),
            )
    return row_to_inquiry(dict(row))


@app.get("/api/v1/inquiries/{inquiry_id}/stage-log")
async def list_inquiry_stage_log(
    inquiry_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """询盘阶段变更历史（TODO(TODO:F4)）：审计与"历史变更可查"的验收入口。"""
    inq = await db.fetchrow(
        request,
        "SELECT id FROM cust_inquiries WHERE id=$1 AND tenant_id=$2",
        inquiry_id, DEFAULT_TENANT, table="cust_inquiries",
    )
    if inq is None or not _owner_visible(user, inq):
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "INQUIRY_NOT_FOUND"})
    rows = await db.fetch(
        request,
        "SELECT from_stage, to_stage, source_event, actor_id, note, created_at"
        " FROM inquiry_stage_log WHERE tenant_id=$1 AND inquiry_id=$2"
        " ORDER BY created_at, id",
        DEFAULT_TENANT, inquiry_id,
    )
    return {
        "items": [
            {
                "from_stage": r["from_stage"],
                "to_stage": r["to_stage"],
                "source_event": r["source_event"],
                "actor_id": r["actor_id"],
                "note": r["note"],
                "created_at": (
                    r["created_at"].isoformat()
                    if hasattr(r["created_at"], "isoformat") else r["created_at"]
                ),
            }
            for r in rows
        ]
    }
