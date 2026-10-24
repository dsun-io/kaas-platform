/**
 * P0 热读直连 · 站内通知未读数（`AUTH_DB_SPLIT=on` 时启用）。
 *
 * 设计 = docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md §3.2：`GET /notifications/unread-count`
 * **每个页面都会拉**（铃铛角标），事故中大量 502 ⇒ 直连 Hyperdrive。
 *
 * 真源逐条直译：backend/worker/src/ws_approvals.py:618-629 `unread_notification_count`。
 * 与审批中心侧边栏角标同源计数（同一条 SQL：tenant + user + read_at IS NULL）。
 *
 * 边界：只读、只做序列化；通知语义/标记已读等写操作仍在内核（本期不动）。
 */
import { Hono, type Context } from "hono";

import { DIRECT_ROUTE_IDS, useDirectRoute } from "../boot-flag";
import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import { directDb } from "../hot-read";
import { num0, respond } from "../http";
import { forwardKernelRequest } from "../proxy";
import { requireUser, type CurrentUser } from "../session";

const DEFAULT_TENANT = "default";
type Row = Record<string, unknown>;

/** GET /api/v1/notifications/unread-count（ws_approvals.py:618-629）→ `{unread}`。 */
export async function unreadCountDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const rows = (await withDb(getEnv(c), (sql: Db) =>
    sql.unsafe(
      "SELECT count(*) AS n FROM notifications"
      + " WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL",
      [DEFAULT_TENANT, user.id] as never[],
    ))) as unknown as Row[];
  // Python: int(count or 0)
  return c.json({ unread: num0(rows[0]?.n) });
}

// ══════════════════════════════════════════════════════════════════════════════
// 路由注册（由 src/index.ts 挂载）：每请求判定灰度开关
// ══════════════════════════════════════════════════════════════════════════════

const app = new Hono<{ Bindings: Env }>();

app.get("/api/v1/notifications/unread-count", (c) =>
  respond(c, async () => {
    // 鉴权在最前：401 不打到 DB / 内核（与今天一致）
    const user = await requireUser(c);
    if (useDirectRoute(getEnv(c), DIRECT_ROUTE_IDS.notificationsUnreadCount)) {
      return directDb(c, () => unreadCountDirect(c, user));
    }
    // 开关 off（默认）⇒ 原样透传内核（回退路径）
    return forwardKernelRequest(c);
  }),
);

export default app;
