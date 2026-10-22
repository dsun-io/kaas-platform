/**
 * KaaS TS 门面 · 审批中心 / 站内通知 / 指定审批人（11 条显式路由，M1-e）。
 *
 * 真源逐条对齐 backend/worker/src/ws_approvals.py：
 * - 订单明细变更申请 4 条：ws_approvals.py:220 / 295 / 453 / 463
 *   （已确认订单改货物明细 → 留痕 → 审批 → 批准后应用整批替换 + 重算金额）；
 * - 审批中心 1 条：ws_approvals.py:475（D-12）；
 * - 站内通知 4 条：ws_approvals.py:564 / 591 / 605 / 623；
 * - 指定审批人 2 条：ws_approvals.py:642 / 666（D-11 / D-14，仅团队管理员）。
 *
 * ── 边界（ADR-008 铁纪律）──────────────────────────────────────────────────
 * 本文件只有 **路由注册 + 门面鉴权 + 原样透传**：
 * - 审批路由（指定审批人优先/管理员兜底/自批判定）、通知语义、字段校验全部在 Python 内核；
 * - 门面不写任何业务 if，也不解析/重写 body —— 请求原样到内核，响应原样回调用方；
 * - 透传实现统一走 src/proxy.ts:forwardAuthenticatedKernelRequest（与 proxy mount 同一份代码）。
 *
 * 这些端点在 backend/ts-migration/routes.json 里都是 auth=true（内核 depends=_get_current_user），
 * 因此 handler 先做门面鉴权：匿名/坏 token → 401（不打到内核），其余交给内核按业务裁决。
 */
import { Hono, type Context } from "hono";

import type { Env } from "../env";
import { respond } from "../http";
import { forwardAuthenticatedKernelRequest } from "../proxy";

const app = new Hono<{ Bindings: Env }>();

/** 显式透传 handler：门面鉴权（401/403）→ 原样转发内核 → 2xx/4xx 原样回，5xx 归一 kernel_error。 */
function forward(c: Context): Promise<Response> {
  return respond(c, async () => forwardAuthenticatedKernelRequest(c));
}

// ── 订单明细变更申请（ws_approvals.py:220-470）────────────────────────────────
app.post("/api/v1/orders/:order_id/item-change-requests", forward);
app.get("/api/v1/orders/:order_id/item-change-requests", forward);
app.post("/api/v1/orders/:order_id/item-change-requests/:rid/approve", forward);
app.post("/api/v1/orders/:order_id/item-change-requests/:rid/reject", forward);

// ── 审批中心（ws_approvals.py:475）────────────────────────────────────────────
app.get("/api/v1/approvals", forward);

// ── 站内通知（ws_approvals.py:564-639）────────────────────────────────────────
app.get("/api/v1/notifications", forward);
app.get("/api/v1/notifications/unread-count", forward);
app.post("/api/v1/notifications/:notification_id/read", forward);
app.post("/api/v1/notifications/read-all", forward);

// ── 指定审批人（ws_approvals.py:642-712；仅团队管理员，内核判权）──────────────
app.get("/api/v1/team/approvers", forward);
app.put("/api/v1/team/approvers", forward);

export default app;
