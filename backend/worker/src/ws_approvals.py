"""已确认订单明细变更审批 + 站内通知 + 指定审批人（设计 §6.1 / §6.2，M1-e）。

用户 2026-10-22 拍板（D-8 / D-10~D-14）：
- 已确认订单的货物明细**允许改、留痕、需审批**；提交时订单本身不变化，
  批准后才应用整批替换 + 重算金额；
- 审批人路由：**有指定审批人 → 归他们；未指定 → 团队管理员**；
  指定审批人长期不处理时管理员可兜底（审计标注），避免流程卡死；
- 自批：申请人不能批自己的申请；若可批集合只剩申请人（单人团队），
  允许自批并在审计标注「自批」；
- 通知只做**审批相关**（approval_requested / approved / rejected），
  不建设通用事件总线（`domain_events` 按 G-15 暂缓）；
- 邮件通道默认关（站内已有记录），同申请只发一次，失败只记日志。

本模块只写"审批/通知"这一层的业务规则；订单本身的读写、行项替换、
金额重算全部复用 main 的实现（`_replace_order_items` /
`_recompute_order_total` / `_validate_order_item_lines`）—— 不另写一份。
"""
from __future__ import annotations

import json as _json
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import Depends, HTTPException, Query, Request

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT
db = _main.db
_acquire = _main._acquire
_owner_visible = _main._owner_visible
_check_write_access = _main._check_write_access
_can_see_all = _main._can_see_all
_order_conn_or_404 = _main._order_conn_or_404
_order_dict = _main._order_dict
_is_admin_role = _main.is_admin_role

# 变更申请状态机（与迁移 202610220005 的 CHECK 一致）
_REQUEST_PENDING = "pending"
_REQUEST_APPROVED = "approved"
_REQUEST_REJECTED = "rejected"

# 通知类型（与 ck_notifications_type 一致）
NOTIF_REQUESTED = "approval_requested"
NOTIF_APPROVED = "approval_approved"
NOTIF_REJECTED = "approval_rejected"

# 「待我审批」/「已处理」视图的合法值
_APPROVAL_VIEWS = ("pending", "mine", "done")


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    if dt is None:
        return None
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)


def _json_obj(value):
    """jsonb 列：asyncpg 在 Workers 里可能返回 str；解析失败按 None（不抛 500）。"""
    if isinstance(value, str):
        try:
            return _json.loads(value) if value.strip() else None
        except ValueError:
            return None
    return value


# ── 审批人路由（D-11 / D-14）───────────────────────────────────────────────

async def _approver_user_ids(conn, team_id) -> List[int]:
    """这个团队的审批人 user_id 列表。

    ① 有指定审批人（team_approvers 非空）→ 只归他们；
    ② 未指定 → 团队管理员（团队内 role 为管理员 / is_tenant_admin / 团队创建者）；
    ③ 订单没有团队（历史数据）→ 全租户系统管理员兜底。
    """
    if team_id is not None:
        rows = await conn.fetch(
            "SELECT user_id FROM team_approvers WHERE team_id=$1"
            " ORDER BY user_id", team_id,
        )
        if rows:
            return [int(r["user_id"]) for r in rows]
        rows = await conn.fetch(
            "SELECT u.id FROM users u"
            " LEFT JOIN teams t ON t.id = u.team_id"
            " WHERE u.team_id = $1"
            "   AND (u.role IN ('system_admin', 'admin')"
            "        OR u.is_tenant_admin = true"
            "        OR t.created_by = u.id)"
            " ORDER BY u.id", team_id,
        )
        if rows:
            return [int(r["id"]) for r in rows]
    rows = await conn.fetch(
        "SELECT id FROM users WHERE tenant_id = $1"
        " AND (role IN ('system_admin', 'admin') OR is_tenant_admin = true)"
        " ORDER BY id", DEFAULT_TENANT,
    )
    return [int(r["id"]) for r in rows]


async def _can_decide(conn, request_row: dict, user: dict) -> tuple[bool, str]:
    """当前用户能否审批这条申请 → (可否, 原因)。

    - 管理员**永远可以**（兜底：指定审批人长期不处理时流程不能卡死）；
      若他本来就在路由名单上，原因记 `approver`，否则记 `admin_fallback`（审计可见）；
    - 非管理员必须是该申请路由上的审批人；
    - 申请人不能批自己的申请 —— 除非可批集合只剩他（单人团队），
      此时放行并标注 `self_approve_solo`。
    """
    approvers = await _approver_user_ids(conn, request_row.get("team_id"))
    user_id = int(user.get("id") or 0)
    is_admin = _is_admin_role(user.get("role"))
    if user_id not in approvers:
        if is_admin:
            return True, "admin_fallback"
        return False, "NOT_APPROVER"
    requested_by = request_row.get("requested_by")
    if requested_by is not None and int(requested_by) == user_id:
        # 自批只在"只剩申请人"时放行（单人团队 / 指定审批人=申请人且无管理员）
        if approvers == [user_id]:
            return True, "self_approve_solo"
        return False, "SELF_APPROVAL"
    # 管理员本来就在路由名单上：原因记 approver（不是 admin_fallback）
    return True, "approver"


# ── 通知（D-10）：与主流程同事务写入，best-effort，失败不阻塞业务 ────────────

async def _notify(conn, *, user_id: int, team_id, type_: str, title: str,
                  body: Optional[str] = None, link: Optional[str] = None,
                  ref_type: Optional[str] = None, ref_id=None) -> None:
    """给**一个人**落一条站内通知。

    为什么逐人落行而不是一条群发：已读是 per-user 的，A 读了不该影响 B 的未读角标。
    """
    await conn.execute(
        "INSERT INTO notifications"
        " (tenant_id, team_id, user_id, type, title, body, link, ref_type, ref_id)"
        " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        DEFAULT_TENANT, team_id, user_id, type_, title, body, link,
        ref_type, ref_id,
    )


async def _notify_approvers(conn, *, team_id, title: str, body: Optional[str],
                            link: str, ref_type: str, ref_id) -> List[int]:
    """按路由给审批人逐个发通知，返回实际收到的人（提交方/前端提示用）。"""
    approvers = await _approver_user_ids(conn, team_id)
    for user_id in approvers:
        await _notify(conn, user_id=user_id, team_id=team_id, type_=NOTIF_REQUESTED,
                      title=title, body=body, link=link,
                      ref_type=ref_type, ref_id=ref_id)
    return approvers


def _request_dict(row: dict, order_no: Optional[str] = None) -> dict:
    """变更申请 → API 响应（含新旧明细对比，前端不必再拉一次订单）。"""
    items = _json_obj(row.get("items"))
    snapshot = _json_obj(row.get("snapshot"))
    return {
        "id": row.get("id"),
        "order_id": row.get("order_id"),
        "order_no": order_no,
        "requested_by": row.get("requested_by"),
        "reason": row.get("reason"),
        "items": items if isinstance(items, list) else [],
        "snapshot": snapshot if isinstance(snapshot, list) else [],
        "status": row.get("status"),
        "decided_by": row.get("decided_by"),
        "decided_at": _iso(row.get("decided_at")),
        "decision_reason": row.get("decision_reason"),
        "team_id": row.get("team_id"),
        "created_at": _iso(row.get("created_at")),
    }


async def _order_items_snapshot(conn, order_id: int) -> List[dict]:
    """提交申请时的旧明细快照（审批页做新旧对比用）。"""
    rows = await conn.fetch(
        "SELECT sku_id, product_name, spec_snapshot, qty, qty_unit,"
        " unit_price, currency, line_amount, sort_order"
        " FROM order_items WHERE tenant_id=$1 AND order_id=$2"
        " ORDER BY sort_order, id", DEFAULT_TENANT, order_id,
    )
    out = []
    for r in rows:
        d = dict(r)
        spec = d.get("spec_snapshot")
        if isinstance(spec, str):
            try:
                spec = _json.loads(spec)
            except ValueError:
                spec = None
        out.append({
            "sku_id": d.get("sku_id"),
            "product_name": d.get("product_name"),
            "spec_snapshot": spec,
            "qty": float(d["qty"]) if d.get("qty") is not None else None,
            "qty_unit": d.get("qty_unit"),
            "unit_price": float(d["unit_price"]) if d.get("unit_price") is not None else None,
            "currency": d.get("currency"),
            "line_amount": float(d["line_amount"]) if d.get("line_amount") is not None else None,
            "sort_order": d.get("sort_order"),
        })
    return out


# ── 端点：变更申请提交 / 历史 ───────────────────────────────────────────────

@app.post("/api/v1/orders/{order_id}/item-change-requests", status_code=201)
async def create_item_change_request(
    order_id: int, request: Request, body: dict,
    user: dict = Depends(_get_current_user),
):
    """提交已确认订单的货物明细变更申请（设计 §6.1）。

    - 订单状态必须是 `pending` 之外（pending 直接 PATCH，不必走审批）；
    - **提交时订单不变化**：先留痕，批准后才应用；
    - `items` 是新明细（整批替换语义，与 PATCH /orders/{id} 同构）；
    - `snapshot` 存提交时的旧明细 —— 审批页的新旧对比不能依赖订单当前值。
    """
    items_in = body.get("items")
    if not isinstance(items_in, list) or not items_in:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_ITEMS",
            "field": "items", "detail": "items 必须是非空数组（整批替换）",
        })
    async with _acquire(request) as conn:
        async with conn.transaction():
            order = await _order_conn_or_404(conn, order_id, user)
            if order.get("status") == "pending":
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "ORDER_ITEMS_EDITABLE",
                    "detail": ("待确认订单可直接编辑货物明细"
                               "（PATCH /orders/{id} 传 items），无需审批"),
                    "order_status": order.get("status"),
                })
            # 同一订单同时只允许一条待审申请：否则两条都批准会互相覆盖，
            # 且"以哪份为准"说不清。
            pending = await conn.fetchrow(
                "SELECT id FROM order_item_change_requests"
                " WHERE tenant_id=$1 AND order_id=$2 AND status='pending'",
                DEFAULT_TENANT, order_id,
            )
            if pending is not None:
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "CHANGE_REQUEST_PENDING",
                    "detail": ("该订单已有一条待审的明细变更申请"
                               f"（#{pending['id']}），请先处理它"),
                    "request_id": pending["id"],
                })
            # 数值校验与新建/替换同口径（PARITY-QUOTE-10）：非法数字在这里就 422，
            # 不要等到批准后才发现应用不了。
            _main._validate_order_item_lines(
                items_in, currency=order.get("currency") or "USD")
            snapshot = await _order_items_snapshot(conn, order_id)
            row = await conn.fetchrow(
                """INSERT INTO order_item_change_requests
                       (tenant_id, order_id, requested_by, reason, items,
                        snapshot, status, team_id)
                   VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,'pending',$7)
                   RETURNING *""",
                DEFAULT_TENANT, order_id, user.get("id"),
                body.get("reason"), _json.dumps(items_in),
                _json.dumps(snapshot) if snapshot else "[]", order.get("team_id"),
            )
            link = f"/approvals?focus={row['id']}"
            notified = await _notify_approvers(
                conn, team_id=order.get("team_id"),
                title=f"订单 {order.get('order_no')} 的货物明细变更待审批",
                body=(body.get("reason") or None),
                link=link, ref_type="order_item_change_request", ref_id=row["id"],
            )
            await _main._record_business_event(
                request, "order.item_change_requested",
                {"order_id": str(order_id), "request_id": str(row["id"]),
                 "items_count": str(len(items_in)),
                 "notified": ",".join(str(x) for x in notified) or "none",
                 "actor_id": str(user["id"])},
                from_ws="order", to_ws="order", conn=conn,
            )
    return {**_request_dict(dict(row)), "notified_approvers": notified}


@app.get("/api/v1/orders/{order_id}/item-change-requests")
async def list_item_change_requests(
    order_id: int, request: Request,
    user: dict = Depends(_get_current_user),
):
    """某订单的变更申请历史（含已处理的，按时间倒序）。"""
    async with _acquire(request) as conn:
        await _order_conn_or_404(conn, order_id, user)
        rows = await conn.fetch(
            "SELECT * FROM order_item_change_requests"
            " WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at DESC, id DESC",
            DEFAULT_TENANT, order_id,
        )
    return {"items": [_request_dict(dict(r)) for r in rows], "total": len(rows)}


# ── 端点：批准 / 拒绝 ──────────────────────────────────────────────────────

async def _decide_change_request(request: Request, order_id: int, rid: int,
                                 body: dict, user: dict, *, approve: bool):
    """批准 / 拒绝的共用骨架（D-8）。

    批准：应用整批替换 + 重算金额 + 写审计 + 通知申请人；
    拒绝：必填理由，订单原样不动，同样通知申请人。
    两条路都要求"能审批"（路由 + 自批规则 + 管理员兜底）。
    """
    async with _acquire(request) as conn:
        async with conn.transaction():
            await _order_conn_or_404(conn, order_id, user)
            row = await conn.fetchrow(
                "SELECT * FROM order_item_change_requests"
                " WHERE tenant_id=$1 AND id=$2 AND order_id=$3",
                DEFAULT_TENANT, rid, order_id,
            )
            if row is None:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "CHANGE_REQUEST_NOT_FOUND"})
            req = dict(row)
            if req.get("status") != _REQUEST_PENDING:
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "CHANGE_REQUEST_ALREADY_DECIDED",
                    "detail": (f"该申请已是 {req.get('status')} 状态，"
                               "不能重复审批"),
                    "status": req.get("status"),
                })
            can, why = await _can_decide(conn, req, user)
            if not can:
                raise HTTPException(status_code=403, detail={
                    "error": "forbidden", "code": why,
                    "detail": _DECIDE_DENY_TEXT[why],
                })
            reason = body.get("reason") or body.get("decision_reason")
            if not approve and not (reason and str(reason).strip()):
                # 拒绝必填理由：被拒方只看到"被拒了"不知道要改什么
                raise HTTPException(status_code=422, detail={
                    "error": "validation", "code": "DECISION_REASON_REQUIRED",
                    "field": "reason", "detail": "拒绝必须填写理由",
                })
            now = _now()
            if approve:
                # 受影响单证清单（设计 §6.1 第 3 条）：已开单证的订单改明细后
                # 合同/单证可能与货不对板，批准页必须提示要重开哪些。
                docs = await conn.fetch(
                    "SELECT id, doc_type, doc_no, status FROM trade_docs"
                    " WHERE tenant_id=$1 AND order_id=$2", DEFAULT_TENANT, order_id,
                )
                affected = [{"id": d["id"], "doc_type": d["doc_type"],
                             "doc_no": d["doc_no"], "status": d["status"]}
                            for d in docs]
                items = _json_obj(req.get("items")) or []
                # 先读订单：行项替换要用它的币种，重算要用它的 amount_breakdown
                order_now = dict(await conn.fetchrow(
                    "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
                    DEFAULT_TENANT, order_id,
                ))
                # 复用 main 的整批替换（与 PATCH /orders/{id} 同一份实现，
                # 不另写一遍 —— 否则批准后应用的规则会和直接编辑不一样）
                await _main._replace_order_items(
                    conn, tenant_id=DEFAULT_TENANT, order_id=order_id,
                    items=items,
                    currency=order_now.get("currency") or "USD",
                )
                lines_total = await conn.fetchval(
                    "SELECT COALESCE(SUM(line_amount), 0) FROM order_items"
                    " WHERE tenant_id=$1 AND order_id=$2",
                    DEFAULT_TENANT, order_id,
                )
                new_total, new_breakdown = _main._recompute_order_total(
                    order_now, float(lines_total or 0))
                await conn.execute(
                    "UPDATE orders SET total_amount=$1, amount_breakdown=$2::jsonb,"
                    " updated_at=now() WHERE tenant_id=$3 AND id=$4",
                    new_total,
                    _json.dumps(new_breakdown) if new_breakdown is not None else None,
                    DEFAULT_TENANT, order_id,
                )
                # 应收同步口径与 PATCH 一致：**只在还没收到一分钱时**改
                recv = await conn.fetchrow(
                    "SELECT id, received_amount FROM receivables"
                    " WHERE tenant_id=$1 AND order_id=$2", DEFAULT_TENANT, order_id,
                )
                if recv is not None and float(recv.get("received_amount") or 0) == 0:
                    await conn.execute(
                        "UPDATE receivables SET total_amount=$1"
                        " WHERE tenant_id=$2 AND id=$3",
                        new_total, DEFAULT_TENANT, recv["id"],
                    )
            else:
                affected = []
                items = []
                new_total = None
            await conn.execute(
                "UPDATE order_item_change_requests"
                " SET status=$1, decided_by=$2, decided_at=$3, decision_reason=$4,"
                " updated_at=now() WHERE tenant_id=$5 AND id=$6",
                _REQUEST_APPROVED if approve else _REQUEST_REJECTED,
                user.get("id"), now,
                (str(reason).strip() if reason else None),
                DEFAULT_TENANT, rid,
            )
            # 通知申请人（不是审批人）：批准/拒绝都要让他知道
            if req.get("requested_by") is not None:
                await _notify(
                    conn, user_id=int(req["requested_by"]),
                    team_id=req.get("team_id"),
                    type_=NOTIF_APPROVED if approve else NOTIF_REJECTED,
                    title=(f"订单 #{order_id} 的明细变更已{'批准' if approve else '被拒绝'}"),
                    body=(str(reason).strip() if reason else None),
                    # A4（P0-A）：前端只有 /orders 列表路由（没有 /orders/{id} 页面），
                    # 深链必须写成前端可落地的查询参数形式，否则点击通知 404。
                    # 提交侧保持 /approvals?focus={rid}（审批中心定位到该申请）。
                    link=f"/orders?id={order_id}",
                    ref_type="order_item_change_request", ref_id=rid,
                )
            await _main._record_business_event(
                request,
                "order.item_change_approved" if approve
                else "order.item_change_rejected",
                {"order_id": str(order_id), "request_id": str(rid),
                 "decision": why, "affected_docs": str(len(affected)),
                 "actor_id": str(user["id"])},
                from_ws="order", to_ws="order", conn=conn,
            )
            updated = await conn.fetchrow(
                "SELECT * FROM order_item_change_requests"
                " WHERE tenant_id=$1 AND id=$2", DEFAULT_TENANT, rid,
            )
    return {
        **_request_dict(dict(updated)),
        "applied": bool(approve),
        "affected_docs": affected,
        "new_total_amount": new_total,
    }


_DECIDE_DENY_TEXT = {
    "NOT_APPROVER": "只有该订单的审批人（或管理员）可以审批",
    "SELF_APPROVAL": "不能审批自己提交的申请",
}


@app.post("/api/v1/orders/{order_id}/item-change-requests/{rid}/approve")
async def approve_item_change_request(
    order_id: int, rid: int, request: Request, body: dict,
    user: dict = Depends(_get_current_user),
):
    """批准：应用行项替换 + 重算金额 + 通知申请人 + 列出受影响单证。"""
    return await _decide_change_request(
        request, order_id, rid, body, user, approve=True)


@app.post("/api/v1/orders/{order_id}/item-change-requests/{rid}/reject")
async def reject_item_change_request(
    order_id: int, rid: int, request: Request, body: dict,
    user: dict = Depends(_get_current_user),
):
    """拒绝：必填理由，订单原样不动，通知申请人。"""
    return await _decide_change_request(
        request, order_id, rid, body, user, approve=False)


# ── 端点：审批中心（D-12）──────────────────────────────────────────────────

@app.get("/api/v1/approvals")
async def list_approvals(
    request: Request,
    view: str = Query("pending"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    user: dict = Depends(_get_current_user),
):
    """审批中心聚合列表（本期仅 order_item_change 一种类型）。

    - `pending` 待我审批：我是路由审批人的 pending + 未指定审批人时管理员的 pending；
    - `mine`    我发起的：requested_by = 我（任何状态）；
    - `done`    已处理：我决定过的（approved / rejected）。
    """
    if view not in _APPROVAL_VIEWS:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_VIEW",
            "field": "view", "value": view, "allowed": list(_APPROVAL_VIEWS),
        })
    where = ["r.tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    if view == "pending":
        if _is_admin_role(user.get("role")):
            # 管理员兜底：看得见全部待批（避免指定审批人躺平时流程卡死）
            where.append("r.status = 'pending'")
        else:
            params.append(int(user["id"]))
            where.append("r.status = 'pending'")
            where.append(
                "(EXISTS (SELECT 1 FROM team_approvers a"
                "         WHERE a.team_id = r.team_id AND a.user_id = $%d)"
                " OR (NOT EXISTS (SELECT 1 FROM team_approvers a2"
                "              WHERE a2.team_id = r.team_id)"
                "     AND EXISTS (SELECT 1 FROM orders o"
                "                 WHERE o.tenant_id = r.tenant_id AND o.id = r.order_id"
                "                   AND o.team_id = $%d)))"
                % (len(params), len(params)))
    elif view == "mine":
        params.append(int(user["id"]))
        where.append(f"r.requested_by = ${len(params)}")
    else:  # done
        params.append(int(user["id"]))
        where.append(f"r.decided_by = ${len(params)}")
        where.append("r.status IN ('approved','rejected')")
    cond = " AND ".join(where)
    total = await db.fetchval(
        request,
        f"SELECT count(*) FROM order_item_change_requests r WHERE {cond}", *params)
    rows = await db.fetch(
        request,
        "SELECT r.*, o.order_no, o.status AS order_status, o.total_amount,"
        " o.currency, u.display_name AS requester_name"
        " FROM order_item_change_requests r"
        " LEFT JOIN orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id"
        " LEFT JOIN users u ON u.id = r.requested_by"
        f" WHERE {cond} ORDER BY r.created_at DESC, r.id DESC"
        f" LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}",
        *params, page_size, (page - 1) * page_size,
    )
    # A2（P0-A）：审批行直接带「受影响单证」清单 —— 详情抽屉不必再拉 /trade-docs
    # （非管理员可能 403；静默降级会让"已开合同可能对不上货"的提示消失）。
    # **整页一次 IN 查完**，禁止逐行再查（N+1）；形状与批准响应的 affected_docs 相同。
    row_dicts = [dict(r) for r in rows]
    order_ids = sorted({int(d["order_id"]) for d in row_dicts
                        if d.get("order_id") is not None})
    docs_by_order: dict[int, list[dict]] = {}
    if order_ids:
        doc_rows = await db.fetch(
            request,
            "SELECT order_id, id, doc_type, doc_no, status FROM trade_docs"
            " WHERE tenant_id=$1 AND order_id = ANY($2::bigint[]) ORDER BY id",
            DEFAULT_TENANT, order_ids,
        )
        for doc in doc_rows:
            dd = dict(doc)
            docs_by_order.setdefault(int(dd["order_id"]), []).append({
                "id": dd.get("id"),
                "doc_type": dd.get("doc_type"),
                "doc_no": dd.get("doc_no"),
                "status": dd.get("status"),
            })
    items = []
    for d in row_dicts:
        items.append({
            **_request_dict(d, order_no=d.get("order_no")),
            "order_status": d.get("order_status"),
            "order_total_amount": (float(d["total_amount"])
                                   if d.get("total_amount") is not None else None),
            "order_currency": d.get("currency"),
            "requester_name": d.get("requester_name"),
            # 无单证 = []（不是 None：前端直接 .length / 直接渲染空提示）
            "affected_docs": (docs_by_order.get(int(d["order_id"]), [])
                              if d.get("order_id") is not None else []),
        })
    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ── 端点：站内通知 ────────────────────────────────────────────────────────

def _notification_dict(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "type": row.get("type"),
        "title": row.get("title"),
        "body": row.get("body"),
        "link": row.get("link"),
        "ref_type": row.get("ref_type"),
        "ref_id": row.get("ref_id"),
        "read_at": _iso(row.get("read_at")),
        "created_at": _iso(row.get("created_at")),
    }


@app.get("/api/v1/notifications")
async def list_notifications(
    request: Request,
    unread: Optional[bool] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    user: dict = Depends(_get_current_user),
):
    """我的通知（时间倒序）；`unread=1` 只要未读。"""
    where = ["tenant_id = $1", "user_id = $2"]
    params: list = [DEFAULT_TENANT, int(user["id"])]
    if unread:
        where.append("read_at IS NULL")
    cond = " AND ".join(where)
    total = await db.fetchval(
        request, f"SELECT count(*) FROM notifications WHERE {cond}", *params)
    rows = await db.fetch(
        request,
        f"SELECT * FROM notifications WHERE {cond}"
        f" ORDER BY created_at DESC, id DESC"
        f" LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}",
        *params, page_size, (page - 1) * page_size,
    )
    return {"items": [_notification_dict(dict(r)) for r in rows],
            "total": total, "page": page, "page_size": page_size}


@app.get("/api/v1/notifications/unread-count")
async def unread_notification_count(
    request: Request, user: dict = Depends(_get_current_user),
):
    """铃铛角标（与审批中心侧边栏角标同源计数）。"""
    count = await db.fetchval(
        request,
        "SELECT count(*) FROM notifications"
        " WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL",
        DEFAULT_TENANT, int(user["id"]),
    )
    return {"unread": int(count or 0)}


@app.post("/api/v1/notifications/{notification_id}/read")
async def mark_notification_read(
    notification_id: int, request: Request,
    user: dict = Depends(_get_current_user),
):
    """标记已读。只能标自己的（别人的通知 id 一律 404，不泄露存在性）。"""
    row = await db.fetchrow(
        request,
        "UPDATE notifications SET read_at = now()"
        " WHERE tenant_id=$1 AND id=$2 AND user_id=$3 RETURNING *",
        DEFAULT_TENANT, notification_id, int(user["id"]),
    )
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "NOTIFICATION_NOT_FOUND"})
    return _notification_dict(dict(row))


@app.post("/api/v1/notifications/read-all")
async def mark_all_notifications_read(
    request: Request, user: dict = Depends(_get_current_user),
):
    """全部已读（返回实际标记条数，前端用来提示"清了 N 条"）。"""
    row = await db.fetchrow(
        request,
        "WITH updated AS ("
        " UPDATE notifications SET read_at = now()"
        "  WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL"
        "  RETURNING id)"
        " SELECT count(*) AS n FROM updated",
        DEFAULT_TENANT, int(user["id"]),
    )
    return {"marked": int((row or {}).get("n") or 0)}


# ── 端点：指定审批人（D-11 / D-14，仅团队管理员）──────────────────────────

@app.get("/api/v1/team/approvers")
async def list_team_approvers(
    request: Request, user: dict = Depends(_get_current_user),
):
    """当前用户所属团队的指定审批人；空名单 = 团队管理员审批。"""
    team_id = user.get("team_id")
    if team_id is None:
        return {"team_id": None, "items": [], "fallback": "tenant_admins"}
    rows = await db.fetch(
        request,
        "SELECT a.user_id, a.created_by, a.created_at, u.display_name, u.email"
        " FROM team_approvers a JOIN users u ON u.id = a.user_id"
        " WHERE a.team_id = $1 ORDER BY a.user_id", team_id,
    )
    return {
        "team_id": team_id,
        "items": [{"user_id": r["user_id"], "display_name": r["display_name"],
                   "email": r["email"], "created_by": r["created_by"],
                   "created_at": _iso(r["created_at"])} for r in rows],
        # 明确告诉前端"空名单时谁来批"，避免页面显示空白让人以为没人管
        "fallback": "team_admins",
    }


@app.put("/api/v1/team/approvers")
async def replace_team_approvers(
    request: Request, body: dict, user: dict = Depends(_get_current_user),
):
    """整表替换指定审批人（仅团队管理员 / 系统管理员）。

    语义是"设成这一份"而不是"追加/删除一条"：团队规模小、名单短，
    整表替换的交互最简单，也不会出现"删了又冒出来"的并发歧义。
    """
    team_id = user.get("team_id")
    if team_id is None:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "NO_TEAM",
            "detail": "未加入团队，无法设置指定审批人",
        })
    if not (_is_admin_role(user.get("role"))
            or await _is_team_admin(request, team_id, user)):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NOT_TEAM_ADMIN",
            "detail": "只有团队管理员可以设置指定审批人",
        })
    raw = body.get("user_ids")
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_USER_IDS",
            "field": "user_ids", "detail": "user_ids 必须是数组",
        })
    user_ids: list[int] = []
    for item in raw:
        try:
            uid = int(item)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "INVALID_USER_ID",
                "field": "user_ids", "detail": f"user_id 必须是数字：{item!r}",
            })
        if uid not in user_ids:
            user_ids.append(uid)
    async with _acquire(request) as conn:
        async with conn.transaction():
            # 只接受**本团队**的成员：把别的团队的人设成审批人，
            # 他会收到不属于自己团队的待批，团队边界就白做了。
            members = await conn.fetch(
                "SELECT id FROM users WHERE team_id = $1", team_id,
            )
            member_ids = {int(r["id"]) for r in members}
            rejected = [uid for uid in user_ids if uid not in member_ids]
            if rejected:
                raise HTTPException(status_code=422, detail={
                    "error": "validation", "code": "APPROVER_NOT_IN_TEAM",
                    "field": "user_ids", "detail": "指定审批人必须是本团队成员",
                    "rejected": rejected,
                })
            await conn.execute(
                "DELETE FROM team_approvers WHERE team_id = $1", team_id)
            for uid in user_ids:
                await conn.execute(
                    "INSERT INTO team_approvers (team_id, user_id, created_by)"
                    " VALUES ($1,$2,$3)", team_id, uid, user.get("id"))
            rows = await conn.fetch(
                "SELECT a.user_id, a.created_by, a.created_at, u.display_name,"
                " u.email FROM team_approvers a JOIN users u ON u.id = a.user_id"
                " WHERE a.team_id = $1 ORDER BY a.user_id", team_id,
            )
    return {
        "team_id": team_id,
        "items": [{"user_id": r["user_id"], "display_name": r["display_name"],
                   "email": r["email"], "created_by": r["created_by"],
                   "created_at": _iso(r["created_at"])} for r in rows],
        "fallback": "team_admins",
    }


async def _is_team_admin(request, team_id, user: dict) -> bool:
    """团队管理员 = 团队创建者 或 团队内 role 为管理员的成员。"""
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "SELECT u.id FROM users u LEFT JOIN teams t ON t.id = u.team_id"
            " WHERE u.id = $1 AND u.team_id = $2"
            "   AND (t.created_by = u.id OR u.role IN ('system_admin','admin')"
            "        OR u.is_tenant_admin = true)",
            user.get("id"), team_id,
        )
    return row is not None
