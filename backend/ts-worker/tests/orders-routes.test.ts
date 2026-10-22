/**
 * orders 域路由测试（真源 = backend/worker/src/main.py:3389-4152 + ws_extras/ws_shipments）。
 *
 * 重点：
 * - 无 token → 401；
 * - 列表 status 非法值 → 422 INVALID_ENUM（不能静默返回空列表）；
 * - 成员列表带归属/团队谓词，输出走 row_to_order 20 键；
 * - 状态机非法流转 → 409 ILLEGAL_TRANSITION（allowed 列表是前端契约）；
 * - 单据客户闸门：缺 customer_id → 422 CUSTOMER_REQUIRED（M2-B 起由内核裁决、门面原样透传）；
 * - 不可见订单 → 404（detail 是字符串 "ORDER_NOT_FOUND"，与 Python 一致）；
 * - M2-B：POST /orders 改透传内核（来源三元组 inquiry_id/source_type/source_channel 不再被丢弃）；
 * - M2-B：GET /orders 来源筛选 source_type / source_channel / inquiry_id（非法枚举 422 INVALID_ENUM）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { createToken } from "../src/session";
import { FIXED_SECRET, dbCallsContaining, makeTestEnv, resetDb, TEST_ENV, type DbRow } from "./helpers";

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

async function request(path: string, user: DbRow | null, init: RequestInit = {}, env?: typeof TEST_ENV): Promise<Response> {
  const headers = new Headers(init.headers);
  if (user !== null) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { ...init, headers }, env ?? TEST_ENV);
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

  it("来源筛选：source_type / source_channel / inquiry_id → SQL 谓词与参数顺序", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("count(*) AS n FROM orders")) return [{ n: "0" }];
      if (query.includes("FROM orders")) return [];
      return [];
    });

    const res = await request(
      "/api/v1/orders?source_type=inquiry&source_channel=phone&inquiry_id=42",
      user,
    );

    expect(res.status).toBe(200);
    const listCall = dbCallsContaining("ORDER BY created_at DESC")[0]!;
    // 谓词与参数按 main.py:3743-3754 的顺序（来源三件套在 customer_id 之后、q 之前）
    expect(listCall.query).toContain("source_type = $2");
    expect(listCall.query).toContain("source_channel = $3");
    expect(listCall.query).toContain("inquiry_id = $4");
    expect(listCall.params).toEqual(["default", "inquiry", "phone", 42, "5", 7, 20, 0]);
  });

  it("source_type 非法值 → 422 INVALID_ENUM（allowed 只列 inquiry/direct）", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/orders?source_type=quote", user);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "invalid_enum_value",
        code: "INVALID_ENUM",
        field: "order_source_type",
        value: "quote",
        allowed: ["inquiry", "direct"],
      },
    });
    // 非法枚举不进 SQL（与 status 同口径：不能静默返回空列表）
    expect(dbCallsContaining("FROM orders WHERE")).toHaveLength(0);
  });

  it("source_channel 非法值 → 422 INVALID_ENUM（渠道清单与询盘同源）", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/orders?source_channel=wechat", user);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "invalid_enum_value",
        code: "INVALID_ENUM",
        field: "source_channel",
        value: "wechat",
        allowed: ["email", "whatsapp", "alibaba", "expo", "website", "phone", "referral", "other"],
      },
    });
    expect(dbCallsContaining("FROM orders WHERE")).toHaveLength(0);
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
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () => new Response(
          JSON.stringify({ detail: { error: "conflict", code: "ILLEGAL_TRANSITION", field: "status", from: "pending", to: "completed", allowed: ["confirmed", "cancelled"] } }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      },
    });

    const res = await request("/api/v1/orders/31/status", user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    }, env);

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
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () => new Response(
          JSON.stringify({ detail: { error: "validation", code: "STATUS_REQUIRED", field: "status", detail: "缺少目标状态 status" } }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      },
    });

    const res = await request("/api/v1/orders/31/status", user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }, env);

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

describe("PATCH /api/v1/orders/{order_id}（M1-f：透传内核）", () => {
  it("原样转发 Authorization/body 到内核并透传响应", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));
    const seen: { path: string; method: string; auth: string | null; body: string }[] = [];
    const env = makeTestEnv({
      KERNEL: {
        fetch: async (input: Request) => {
          seen.push({
            path: new URL(input.url).pathname,
            method: input.method,
            auth: input.headers.get("authorization"),
            body: await input.text(),
          });
          return new Response(JSON.stringify({ id: 31, source_type: "inquiry" }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        },
      },
    });

    const res = await request("/api/v1/orders/31", user, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ product_name: "A", quantity: 2 }] }),
    }, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 31, source_type: "inquiry" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/api/v1/orders/31");
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.auth).toMatch(/^Bearer /);
    expect(JSON.parse(seen[0]!.body)).toEqual({ items: [{ product_name: "A", quantity: 2 }] });
  });

  it("内核 4xx 原样透传（不吞错、不改形状）", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () => new Response(
          JSON.stringify({ detail: { error: "conflict", code: "ORDER_NOT_PENDING", detail: "订单已确认" } }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      },
    });

    const res = await request("/api/v1/orders/31", user, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "x" }),
    }, env);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: { error: "conflict", code: "ORDER_NOT_PENDING", detail: "订单已确认" } });
  });
});

describe("POST /api/v1/orders（M2-B：透传内核）", () => {
  it("原样转发 body（含 inquiry_id/source_type/source_channel）+ 透传内核 201", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));
    const seen: { path: string; method: string; auth: string | null; body: string }[] = [];
    const env = makeTestEnv({
      KERNEL: {
        fetch: async (input: Request) => {
          seen.push({
            path: new URL(input.url).pathname,
            method: input.method,
            auth: input.headers.get("authorization"),
            body: await input.text(),
          });
          return new Response(
            JSON.stringify({ id: 31, source_type: "inquiry", source_channel: "phone", inquiry_id: 42 }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        },
      },
    });
    const payload = {
      customer_id: 9,
      currency: "USD",
      inquiry_id: 42,
      source_type: "inquiry",
      source_channel: "phone",
      items: [{ product_name: "A", quantity: 2 }],
    };

    const res = await request("/api/v1/orders", user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, env);

    // 内核 status_code=201 原样透传（门面不再自己决定建单状态码）
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: 31, source_type: "inquiry", source_channel: "phone", inquiry_id: 42,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/api/v1/orders");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.auth).toMatch(/^Bearer /);
    // 关键回归：来源三元组必须原样到内核（旧门面 SQL 会把它们静默丢弃）
    expect(JSON.parse(seen[0]!.body)).toEqual(payload);
    // 门面不再自己建单：没有任何 orders/order_items 写入
    expect(dbCallsContaining("INSERT INTO orders")).toHaveLength(0);
    expect(dbCallsContaining("INSERT INTO order_items")).toHaveLength(0);
  });

  it("内核 4xx 原样透传：缺 customer_id → 422 CUSTOMER_REQUIRED", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () => new Response(
          JSON.stringify({
            detail: {
              error: "validation", code: "CUSTOMER_REQUIRED", field: "customer_id",
              detail: "单据必须归属业务客户：请从已有业务客户里选择",
            },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      },
    });

    const res = await request("/api/v1/orders", user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currency: "USD", items: [] }),
    }, env);

    expect(res.status).toBe(422);
    const body = await res.json() as { detail: DbRow };
    expect(body.detail.code).toBe("CUSTOMER_REQUIRED");
    expect(body.detail.field).toBe("customer_id");
  });

  it("无 token → 401 且不触达内核", async () => {
    let called = false;
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () => {
          called = true;
          return new Response("{}", { status: 200 });
        },
      },
    });

    const res = await request("/api/v1/orders", null, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer_id: 9 }),
    }, env);

    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });
});
