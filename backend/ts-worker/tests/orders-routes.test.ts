/**
 * orders 域路由测试（真源 = backend/worker/src/main.py:3389-4152 + ws_extras/ws_shipments）。
 *
 * 重点：
 * - 无 token → 401；
 * - 列表 status 非法值 → 422 INVALID_ENUM（不能静默返回空列表）；
 * - 成员列表带归属/团队谓词，输出走 row_to_order 20 键；
 * - 状态机非法流转 → 409 ILLEGAL_TRANSITION（allowed 列表是前端契约）；
 * - 单据客户闸门：缺 customer_id → 422 CUSTOMER_REQUIRED；
 * - 不可见订单 → 404（detail 是字符串 "ORDER_NOT_FOUND"，与 Python 一致）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { createToken } from "../src/session";
import { FIXED_SECRET, dbCallsContaining, resetDb, TEST_ENV, type DbRow } from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 5,
    email: "owner@qa.test",
    display_name: "Owner",
    account_type: "customer",
    role: "owner",
    status: "active",
    team_id: 7,
    console_access: false,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

const ORDER_ROW: DbRow = {
  id: 31,
  order_no: "ORD-US-ACM-20261021030405",
  customer_id: 9,
  customer_name: "Acme",
  status: "pending",
  currency: "USD",
  total_amount: "1200.50",
  order_date: new Date("2026-10-01T00:00:00Z"),
  delivery_date: null,
  notes: null,
  fx_rate: null,
  fx_rate_date: null,
  created_at: new Date("2026-10-01T03:04:05Z"),
  owner_id: 5,
  owner_scope: "private",
  team_id: 7,
  incoterm: null,
  payment_terms: null,
  port_of_loading: null,
  port_of_destination: null,
  shipping_marks: null,
  country_of_origin: null,
};

async function request(path: string, user: DbRow | null, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (user !== null) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { ...init, headers }, TEST_ENV);
}

beforeEach(() => {
  resetDb(() => []);
});

describe("GET /api/v1/orders", () => {
  it("无 token → 401", async () => {
    const res = await request("/api/v1/orders", null);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
  });

  it("status 非法值 → 422 INVALID_ENUM（带 allowed 清单）", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/orders?status=bogus", user);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "invalid_enum_value",
        code: "INVALID_ENUM",
        field: "order_status",
        value: "bogus",
        allowed: ["pending", "confirmed", "producing", "shipped", "completed", "cancelled"],
      },
    });
  });

  it("成员 → 200，行项按 row_to_order 投影且带归属/团队谓词", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("count(*) AS n FROM orders")) return [{ n: "1" }];
      if (query.includes("FROM orders")) return [ORDER_ROW];
      return [];
    });

    const res = await request("/api/v1/orders", user);

    expect(res.status).toBe(200);
    const body = await res.json() as { items: DbRow[]; total: number; page: number; page_size: number };
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(20);
    expect(body.items[0]).toMatchObject({
      id: 31,
      total_amount: 1200.5,
      order_date: "2026-10-01T00:00:00.000+00:00",
      created_at: "2026-10-01T03:04:05.000+00:00",
      owner_scope: "private",
    });
    const listCall = dbCallsContaining("ORDER BY created_at DESC")[0]!;
    expect(listCall.query).toContain("(owner_id = $2 OR owner_scope = 'tenant' OR team_id = $3)");
    expect(listCall.params).toEqual(["default", "5", 7, 20, 0]);
  });
});

describe("GET /api/v1/orders/{order_id}", () => {
  it("不可见（owner 不符且团队不符）→ 404 detail 为字符串 ORDER_NOT_FOUND", async () => {
    // 换一个人（id=6）+ 别的团队（8）：owner 与 team 都对不上 ⇒ 不可见
    const user = userRow({ id: 6, team_id: 8 });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM orders")) return [ORDER_ROW];
      return [];
    });

    const res = await request("/api/v1/orders/31", user);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "ORDER_NOT_FOUND" });
  });

  it("可见 → 200，补齐 items/quote_refs/payment_schedules/receivable 四个块", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM orders")) return [ORDER_ROW];
      if (query.includes("FROM order_items")) {
        return [{ id: 1, sku_id: "sku-1", product_name: "Hose", spec_snapshot: null, qty: "10", qty_unit: "m", unit_price: "120.05", currency: "USD", line_amount: "1200.5", sort_order: 0 }];
      }
      if (query.includes("FROM entity_links")) return [{ quote_order_id: 77, rel_type: "converted_to" }];
      if (query.includes("FROM payment_schedules")) return [];
      if (query.includes("FROM receivables")) return [];
      return [];
    });

    const res = await request("/api/v1/orders/31", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: 31,
      items: [{ id: 1, qty: 10, unit_price: 120.05, line_amount: 1200.5 }],
      quote_refs: [{ quote_order_id: 77, ref_type: "converted_to" }],
      payment_schedules: [],
      receivable: null,
    });
  });
});

describe("POST /api/v1/orders/{order_id}/status", () => {
  it("非法流转 → 409 ILLEGAL_TRANSITION（allowed 只列 pending 的合法目标）", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM orders")) return [ORDER_ROW];
      return [];
    });

    const res = await request("/api/v1/orders/31/status", user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      detail: {
        error: "conflict",
        code: "ILLEGAL_TRANSITION",
        field: "status",
        from: "pending",
        to: "completed",
        allowed: ["confirmed", "cancelled"],
      },
    });
  });

  it("缺 status → 422 STATUS_REQUIRED（不是 409）", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM orders")) return [ORDER_ROW];
      return [];
    });

    const res = await request("/api/v1/orders/31/status", user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "validation",
        code: "STATUS_REQUIRED",
        field: "status",
        detail: "缺少目标状态 status",
      },
    });
  });
});

describe("POST /api/v1/orders", () => {
  it("缺 customer_id（且无报价来源）→ 422 CUSTOMER_REQUIRED", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/orders", user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currency: "USD", items: [] }),
    });

    expect(res.status).toBe(422);
    const body = await res.json() as { detail: DbRow };
    expect(body.detail.code).toBe("CUSTOMER_REQUIRED");
    expect(body.detail.field).toBe("customer_id");
  });
});
