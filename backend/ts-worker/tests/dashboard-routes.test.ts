/**
 * dashboard 域路由测试（真源 = backend/worker/src/main.py:1864-1917）。
 *
 * 重点：401 闸门；count 聚合口径（quotations_total = quotations + quote_orders +
 * cust_inquiries；sampled 恒等于 total；dataset_hits 三个中文键）。
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import dashboardRoutes from "../src/routes/dashboard";
import { createToken } from "../src/session";
import { FIXED_SECRET, resetDb, TEST_ENV, dbState, type DbRow } from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

const app = new Hono();
app.route("/", dashboardRoutes);

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 7,
    email: "dash@qa.test",
    display_name: "Dash User",
    account_type: "internal",
    role: "sales",
    status: "active",
    team_id: null,
    console_access: false,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

async function request(path: string, user: DbRow | null): Promise<Response> {
  const headers = new Headers();
  if (user) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { headers }, TEST_ENV);
}

beforeEach(() => {
  resetDb(() => []);
});

describe("GET /api/v1/dashboard/summary", () => {
  it("无 token → 401", async () => {
    const res = await request("/api/v1/dashboard/summary", null);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
  });

  it("聚合口径与 dataset_hits 键名对齐 Python", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM quotations")) return [{ n: "2" }];
      if (query.includes("FROM quote_orders")) return [{ n: "3" }];
      if (query.includes("FROM cust_inquiries")) return [{ n: "4" }];
      if (query.includes("FROM customers")) return [{ n: "5" }];
      if (query.includes("FROM market_ports")) return [{ n: "6" }];
      if (query.includes("FROM intel_shipments")) return [{ n: "7" }];
      if (query.includes("FROM events")) return [{ n: 8 }];
      return [];
    });

    const res = await request("/api/v1/dashboard/summary?range=7d", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      range: "7d",
      quotations_total: 9,
      quotations_sampled: 9,
      active_customers: 5,
      customers_sampled: 5,
      dataset_hits: { 港口库: 6, 船运情报: 7, 平台事件: 8 },
      token_total: 0,
      token_sampled: 0,
      p95_latency_ms: 0,
      latency_sampled: 0,
    });
    // events 的 since 走参数化（range=7d → 7 天窗口）
    const eventsCall = dbState.calls.find((call) => call.query.includes("FROM events"));
    const since = eventsCall?.params[1] as Date;
    expect(since instanceof Date).toBe(true);
  });
});
