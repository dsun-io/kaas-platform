/**
 * KaaS TS 门面 · dashboard 域（1 条路由）。
 *
 * 真源逐条对齐：backend/worker/src/main.py:1864-1917（dashboard_summary）。
 *
 * 该端点全是 count(*) 聚合，无业务判定：range 只影响 events 的 since 窗口，
 * 其余计数是"当前总量"。sampled 字段当前恒等于 total（Python 注释：无采样层）。
 *
 * SQL 风格：一律 sql.unsafe + 位置参数（$n），与 Python 侧 f-string + $n 的写法
 * 逐条对照（同 customers.ts 动态 WHERE 的做法），禁止字符串拼接用户输入。
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import { num0, parseQuery, respond } from "../http";
import { requireUser } from "../session";

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_TENANT = "default";

type AppEnv = { Bindings: Env };

/** 查询参数压平（c.req.queries() 给的是 string[]；FastAPI 单值参数取首个值）。 */
function queries(c: Context<AppEnv>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    const first = values[0];
    if (first !== undefined) out[key] = first;
  }
  return out;
}

// ── GET /api/v1/dashboard/summary（main.py:1864-1917）───────────────────────
const summaryQuery = z.object({
  range: z.string().nullish(),
});

/** Python since_map（main.py:1871-1875）：缺省/未知取值都落 1 天。 */
const RANGE_DAYS: Record<string, number> = { today: 1, "7d": 7, "30d": 30 };

app.get("/api/v1/dashboard/summary", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(summaryQuery, queries(c));
  const range = query.range ?? "today";
  const days = RANGE_DAYS[range] ?? 1;
  // 对齐 Python：datetime.now(timezone.utc) - timedelta(days=...)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const quotations = await sql.unsafe(
      "SELECT count(*) AS n FROM quotations WHERE tenant_id=$1", [DEFAULT_TENANT]);
    const quoteOrders = await sql.unsafe(
      "SELECT count(*) AS n FROM quote_orders WHERE tenant_id=$1", [DEFAULT_TENANT]);
    const inquiries = await sql.unsafe(
      "SELECT count(*) AS n FROM cust_inquiries WHERE tenant_id=$1", [DEFAULT_TENANT]);
    const customers = await sql.unsafe(
      "SELECT count(*) AS n FROM customers WHERE tenant_id=$1", [DEFAULT_TENANT]);
    const ports = await sql.unsafe(
      "SELECT count(*) AS n FROM market_ports WHERE tenant_id=$1", [DEFAULT_TENANT]);
    const shipments = await sql.unsafe(
      "SELECT count(*) AS n FROM intel_shipments WHERE tenant_id=$1", [DEFAULT_TENANT]);
    const events = await sql.unsafe(
      "SELECT count(*) AS n FROM events WHERE tenant_id=$1 AND created_at >= $2",
      [DEFAULT_TENANT, since]);

    const quotationsTotal = num0(quotations[0]?.n) + num0(quoteOrders[0]?.n) + num0(inquiries[0]?.n);
    const activeCustomers = num0(customers[0]?.n);
    const portCount = num0(ports[0]?.n);
    const shipmentCount = num0(shipments[0]?.n);
    const eventCount = num0(events[0]?.n);

    return {
      range,
      quotations_total: quotationsTotal,
      quotations_sampled: quotationsTotal,
      active_customers: activeCustomers,
      customers_sampled: activeCustomers,
      dataset_hits: {
        港口库: portCount,
        船运情报: shipmentCount,
        平台事件: eventCount,
      },
      token_total: 0,
      token_sampled: 0,
      p95_latency_ms: 0,
      latency_sampled: 0,
    };
  });
  return c.json(payload);
}));

export default app;
