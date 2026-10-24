/**
 * KaaS TS 门面 · 审批中心 / 站内通知 / 指定审批人（10 条显式路由，M1-e）。
 *
 * 真源逐条对齐 backend/worker/src/ws_approvals.py：
 * - 订单明细变更申请 4 条：ws_approvals.py:220 / 295 / 453 / 463
 *   （已确认订单改货物明细 → 留痕 → 审批 → 批准后应用整批替换 + 重算金额）；
 * - 审批中心 1 条：ws_approvals.py:478（D-12）；
 * - 站内通知 3 条：ws_approvals.py:591 / 632 / 650
 *   （`GET /notifications/unread-count` P0 起由 src/routes/notifications.ts 注册）；
 * - 指定审批人 2 条：ws_approvals.py:669 / 693（D-11 / D-14，仅团队管理员）。
 *
 * ── 边界（ADR-008 铁纪律）──────────────────────────────────────────────────
 * 本文件的**写侧/审批动作**只有 **路由注册 + 门面鉴权 + 原样透传**：
 * - 审批路由（指定审批人优先/管理员兜底/自批判定）、通知语义、字段校验全部在 Python 内核；
 * - 门面不写任何业务 if，也不解析/重写 body —— 请求原样到内核，响应原样回调用方；
 * - 透传实现统一走 src/proxy.ts（与 proxy mount 同一份代码）。
 *
 * ── 2026-10-24 P0（docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md §3.2）──────────────
 * `GET /api/v1/approvals`（待办角标，事故中成片 502）新增**只读直连**：
 * `AUTH_DB_SPLIT=on` 时走下面的 SQL（逐条直译 ws_approvals.py:478-572）；
 * **off（默认）仍原样透传内核**，行为与今天逐字一致（一键回退）。
 * 写操作（提交/批准/拒绝/已读）**本期不动**，仍全部透传。
 *
 * 这些端点在 backend/ts-migration/routes.json 里都是 auth=true（内核 depends=_get_current_user），
 * 因此 handler 先做门面鉴权：匿名/坏 token → 401（不打到内核），其余交给内核按业务裁决。
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import { DIRECT_ROUTE_IDS, useDirectRoute } from "../boot-flag";
import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import { directDb } from "../hot-read";
import { httpError, num, num0, parseQuery, pyIso, respond } from "../http";
import { forwardAuthenticatedKernelRequest, forwardKernelRequest } from "../proxy";
import { isAdminRole } from "../rules";
import { requireUser, type CurrentUser } from "../session";

const DEFAULT_TENANT = "default";
type Row = Record<string, unknown>;

const app = new Hono<{ Bindings: Env }>();

/** 显式透传 handler：门面鉴权（401/403）→ 原样转发内核 → 2xx/4xx 原样回，5xx 归一 kernel_error。 */
function forward(c: Context): Promise<Response> {
  return respond(c, async () => forwardAuthenticatedKernelRequest(c));
}

// ══════════════════════════════════════════════════════════════════════════════
// P0 直连读：审批中心列表（真源 ws_approvals.py:478-572）
// ══════════════════════════════════════════════════════════════════════════════

/** ws_approvals.py:51 `_APPROVAL_VIEWS`。 */
const APPROVAL_VIEWS = ["pending", "mine", "done"] as const;

/** FastAPI Query 口径：view 默认 "pending"；page≥1；page_size 1..200。 */
const approvalsQuery = z.object({
  view: z.string().default("pending"),
  page: z.coerce.number().int().gte(1).default(1),
  page_size: z.coerce.number().int().gte(1).lte(200).default(20),
});

/** ws_approvals.py:66-73 `_json_obj`：jsonb 可能是 str；解析失败按 None（不抛 500）。 */
function jsonbMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return value.trim() ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

/** `items`/`snapshot` 只接受数组（ws_approvals.py:176-177）。 */
function jsonbArray(value: unknown): unknown[] {
  const parsed = jsonbMaybe(value);
  return Array.isArray(parsed) ? parsed : [];
}

/** ws_approvals.py:58-63 `_iso`：None → null；datetime → isoformat（微秒差异已登记金标白名单）。 */
function isoOrNull(value: unknown): unknown {
  return value === null || value === undefined ? null : pyIso(value);
}

/**
 * ws_approvals.py:166-184 `_request_dict`：变更申请 → API 响应
 * （含新旧明细对比，前端不必再拉一次订单）。BIGINT 列统一转 int（asyncpg 口径）。
 */
function requestDict(row: Row, orderNo: unknown = null): Row {
  return {
    id: num(row.id),
    order_id: num(row.order_id),
    order_no: orderNo ?? null,
    requested_by: num(row.requested_by),
    reason: row.reason ?? null,
    items: jsonbArray(row.items),
    snapshot: jsonbArray(row.snapshot),
    status: row.status,
    decided_by: num(row.decided_by),
    decided_at: isoOrNull(row.decided_at),
    decision_reason: row.decision_reason ?? null,
    team_id: num(row.team_id),
    created_at: isoOrNull(row.created_at),
  };
}

/**
 * GET /api/v1/approvals（ws_approvals.py:478-572）→
 * `{items, total, page, page_size}`。
 *
 * 三个视图的过滤条件逐字直译：
 * - `pending` 待我审批：管理员兜底看全部 pending；非管理员 = 我是该团队指定审批人
 *   **或**（该团队没有指定审批人 **且** 订单属于我的团队）；
 * - `mine` 我发起的（任何状态）：`r.requested_by = 我`；
 * - `done` 我决定过的：`r.decided_by = 我 AND status IN ('approved','rejected')`。
 */
export async function listApprovalsDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const query = parseQuery(approvalsQuery, c.req.query());
  if (!(APPROVAL_VIEWS as readonly string[]).includes(query.view)) {
    // ws_approvals.py:492-496：非法 view 402/422 明细（不是静默空列表）
    throw httpError(422, {
      error: "validation",
      code: "INVALID_VIEW",
      field: "view",
      value: query.view,
      allowed: [...APPROVAL_VIEWS],
    });
  }

  const where: string[] = ["r.tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (query.view === "pending") {
    where.push("r.status = 'pending'");
    if (!isAdminRole(user.role)) {
      params.push(user.id);
      const idx = params.length;
      // 指定审批人优先；未指定时团队管理员兜底（ws_approvals.py:503-514 逐字）
      where.push(
        "(EXISTS (SELECT 1 FROM team_approvers a"
        + "         WHERE a.team_id = r.team_id AND a.user_id = $" + String(idx) + ")"
        + " OR (NOT EXISTS (SELECT 1 FROM team_approvers a2"
        + "              WHERE a2.team_id = r.team_id)"
        + "     AND EXISTS (SELECT 1 FROM orders o"
        + "                 WHERE o.tenant_id = r.tenant_id AND o.id = r.order_id"
        + "                   AND o.team_id = $" + String(idx) + ")))",
      );
    }
  } else if (query.view === "mine") {
    params.push(user.id);
    where.push("r.requested_by = $" + String(params.length));
  } else {
    params.push(user.id);
    where.push("r.decided_by = $" + String(params.length));
    where.push("r.status IN ('approved','rejected')");
  }
  const cond = where.join(" AND ");

  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const totalRows = (await sql.unsafe(
      "SELECT count(*) AS n FROM order_item_change_requests r WHERE " + cond,
      params as never[],
    )) as unknown as Row[];
    const rows = (await sql.unsafe(
      "SELECT r.*, o.order_no, o.status AS order_status, o.total_amount,"
      + " o.currency, u.display_name AS requester_name"
      + " FROM order_item_change_requests r"
      + " LEFT JOIN orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id"
      + " LEFT JOIN users u ON u.id = r.requested_by"
      + " WHERE " + cond
      + " ORDER BY r.created_at DESC, r.id DESC"
      + " LIMIT $" + String(params.length + 1)
      + " OFFSET $" + String(params.length + 2),
      [...params, query.page_size, (query.page - 1) * query.page_size] as never[],
    )) as unknown as Row[];

    // A2（P0-A）：审批行直接带「受影响单证」清单 —— **整页一次 IN 查完**，禁止逐行再查
    // （N+1）；形状与批准响应的 affected_docs 相同（ws_approvals.py:537-558）。
    const orderIds = [
      ...new Set(
        rows
          .map((row) => row.order_id)
          .filter((id) => id !== null && id !== undefined)
          .map((id) => Number(id)),
      ),
    ].sort((a, b) => a - b);
    const docsByOrder = new Map<number, Row[]>();
    if (orderIds.length) {
      const docRows = (await sql.unsafe(
        "SELECT order_id, id, doc_type, doc_no, status FROM trade_docs"
        + " WHERE tenant_id=$1 AND order_id = ANY($2::bigint[]) ORDER BY id",
        [DEFAULT_TENANT, orderIds] as never[],
      )) as unknown as Row[];
      for (const doc of docRows) {
        const orderId = Number(doc.order_id);
        const list = docsByOrder.get(orderId) ?? [];
        list.push({
          id: num(doc.id),
          doc_type: doc.doc_type,
          doc_no: doc.doc_no,
          status: doc.status,
        });
        docsByOrder.set(orderId, list);
      }
    }

    const items = rows.map((row) => ({
      ...requestDict(row, row.order_no),
      order_status: row.order_status ?? null,
      order_total_amount:
        row.total_amount !== null && row.total_amount !== undefined
          ? Number(row.total_amount)
          : null,
      order_currency: row.currency ?? null,
      requester_name: row.requester_name ?? null,
      // 无单证 = []（不是 None：前端直接 .length / 渲染空提示）
      affected_docs:
        row.order_id !== null && row.order_id !== undefined
          ? (docsByOrder.get(Number(row.order_id)) ?? [])
          : [],
    }));

    return {
      items,
      total: num0(totalRows[0]?.n),
      page: query.page,
      page_size: query.page_size,
    };
  });
  return c.json(payload);
}

// ── 订单明细变更申请（ws_approvals.py:220-470）────────────────────────────────
app.post("/api/v1/orders/:order_id/item-change-requests", forward);
app.get("/api/v1/orders/:order_id/item-change-requests", forward);
app.post("/api/v1/orders/:order_id/item-change-requests/:rid/approve", forward);
app.post("/api/v1/orders/:order_id/item-change-requests/:rid/reject", forward);

// ── 审批中心（ws_approvals.py:478）：P0 起开关 on 直连读，off 仍原样透传 ────────
app.get("/api/v1/approvals", (c) =>
  respond(c, async () => {
    const user = await requireUser(c);
    if (useDirectRoute(getEnv(c), DIRECT_ROUTE_IDS.approvalsList)) {
      return directDb(c, () => listApprovalsDirect(c, user));
    }
    return forwardKernelRequest(c);
  }),
);

// ── 站内通知（ws_approvals.py:591 / 632 / 650；unread-count 在 notifications.ts）──
app.get("/api/v1/notifications", forward);
app.post("/api/v1/notifications/:notification_id/read", forward);
app.post("/api/v1/notifications/read-all", forward);

// ── 指定审批人（ws_approvals.py:669+；仅团队管理员，内核判权）──────────────────
app.get("/api/v1/team/approvers", forward);
app.put("/api/v1/team/approvers", forward);

export default app;
