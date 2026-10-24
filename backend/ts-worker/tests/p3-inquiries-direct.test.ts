/**
 * P3 批次A：询盘读端点门面直连（AUTH_DB_SPLIT=`on`）—— 真源 backend/worker/src/ws_crm_ext.py。
 *
 * 为什么是这三条：customers 域其它读**早已**在门面直连（route-classification「门面注册/
 * 移植 193 条」），M1-f 因「形状全在内核」把询盘三条 GET 留成 forwardAuthenticatedKernelRequest
 * ⇒ 内核 Pyodide 冷启动 502 时询盘工位 /inquiries 与客户页询盘抽屉整块不可用。
 *
 * 覆盖（与 P0 同一套断言口径）：
 * - 开关 on：200，且 env.KERNEL.fetch 一次都不被调用；
 * - SQL 与 ws_crm_ext.py 逐字对照：三段结构、参数顺序、排序、可见性谓词；
 * - 开关 off（默认）：仍走 KERNEL.fetch，path/search 与今天逐字一致（一键回退）；
 * - 团队隔离：非管理员列表带三层可见性谓词；别团队询盘详情 404（不泄露存在性）；
 *   stage-log 沿用内核现状（只查 id ⇒ 非管理员恒 404，见交付疑问 Q1）；
 * - 401 未鉴权：不打 DB / 内核；
 * - TS-DB 失败：503 {error:"db_unavailable",retryable:true}。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { DB_UNAVAILABLE_MESSAGE } from "../src/hot-read";
import { createToken } from "../src/session";
import {
  FIXED_SECRET,
  dbCallsContaining,
  dbState,
  makeTestEnv,
  resetDb,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

// ── 测试脚手架（与 tests/p0-hot-reads.test.ts 同一套）────────────────────────

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 9,
    email: "staff@qa.test",
    display_name: "Staff",
    account_type: "internal",
    role: "sales",
    status: "active",
    team_id: 4,
    console_access: true,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

const ADMIN_ROW: DbRow = { role: "admin", is_tenant_admin: true };

function kernelSpy(flag: Record<string, unknown> = {}): {
  seen: Array<{ method: string; path: string; search: string }>;
  fetch: ReturnType<typeof vi.fn>;
  env: ReturnType<typeof makeTestEnv>;
} {
  const seen: Array<{ method: string; path: string; search: string }> = [];
  const fetch = vi.fn(async (input: Request | string) => {
    const req = input instanceof Request ? input : new Request(input);
    const url = new URL(req.url);
    seen.push({ method: req.method, path: url.pathname, search: url.search });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const env = makeTestEnv({ KERNEL: { fetch: fetch as never }, ...flag });
  return { seen, fetch, env };
}

function onEnv(flag: Record<string, unknown> = {}) {
  return kernelSpy({ AUTH_DB_SPLIT: "on", ...flag });
}

async function request(
  path: string,
  user: DbRow | null,
  env: ReturnType<typeof makeTestEnv>,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (user !== null) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { ...init, headers }, env);
}

/** 关断路径的公共断言：只有一次 KERNEL.fetch，path/search 与旧透传逐字一致。 */
function expectForwarded(
  spy: ReturnType<typeof kernelSpy>,
  path: string,
  search = "",
): void {
  expect(spy.seen).toHaveLength(1);
  expect(spy.seen[0]).toEqual({ method: "GET", path, search });
}

function iso(text: string): string {
  return new Date(text).toISOString().replace("Z", "+00:00");
}

/** 询盘行（列名与 cust_inquiries 一致；只测投影用到的列）。 */
function inquiryRow(overrides: DbRow = {}): DbRow {
  return {
    id: "11",
    customer_id: "3",
    inquiry_no: "INQ-2026-0011",
    lead_id: null,
    channel: "whatsapp",
    category_id: null,
    product_name_raw: "chain link fence",
    quantity: "120",
    quantity_unit: "roll",
    application: null,
    items: [],
    status: "unquoted",
    stage: "inquiry",
    stage_updated_at: null,
    created_at: new Date("2026-10-01T02:03:04Z"),
    owner_id: "9",
    owner_scope: "private",
    team_id: "4",
    company_name: "Acme Trading",
    quote_count: "2",
    order_count: "1",
    latest_quote_at: new Date("2026-10-02T03:04:05Z"),
    ...overrides,
  };
}

/** 按 SQL 片段路由的 DB 桩（unsafe 的原样 SQL 保留 $n，可直接做逐字断言）。 */
function dbStub(rows: {
  user?: DbRow;
  inquiries?: DbRow[];
  inquiry?: DbRow | null;
  quotes?: DbRow[];
  quoteItems?: DbRow[];
  quoteOrders?: DbRow[];
  orders?: DbRow[];
  stageLog?: DbRow[];
  stageLogInquiry?: DbRow | null;
}): (query: string) => DbRow[] {
  return (query: string): DbRow[] => {
    if (query.includes("FROM users WHERE id")) return rows.user ? [rows.user] : [];
    if (query.includes("SELECT id FROM cust_inquiries WHERE id=")) {
      return rows.stageLogInquiry ? [rows.stageLogInquiry] : [];
    }
    if (query.includes("company_name FROM cust_inquiries")) {
      return rows.inquiry ? [rows.inquiry] : [];
    }
    if (query.includes("FROM cust_inquiries i")) return rows.inquiries ?? [];
    if (query.includes("SELECT count(*) FROM quote_order_items")) return rows.quoteItems ?? [{ count: "0" }];
    if (query.includes("SELECT count(*) FROM orders")) return rows.quoteOrders ?? [{ count: "0" }];
    if (query.includes("FROM quote_orders WHERE tenant_id=$1 AND inquiry_id=$2")) {
      return rows.quotes ?? [];
    }
    if (query.includes("SELECT * FROM orders WHERE tenant_id=$1")) return rows.orders ?? [];
    if (query.includes("FROM inquiry_stage_log")) return rows.stageLog ?? [];
    return [];
  };
}

beforeEach(() => {
  resetDb(() => []);
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/inquiries（ws_crm_ext.py:303-399 list_inquiries）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/inquiries（P3 直连）", () => {
  it("开关 on：200 + 形状与内核逐字段一致 + 全程不经内核", async () => {
    resetDb(dbStub({ user: userRow(), inquiries: [inquiryRow()] }));
    const spy = onEnv();

    const res = await request("/api/v1/inquiries", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          id: 11,
          customer_id: 3,
          inquiry_no: "INQ-2026-0011",
          lead_id: null,
          channel: "whatsapp",
          category_id: null,
          product_name_raw: "chain link fence",
          quantity: 120,
          quantity_unit: "roll",
          application: null,
          items: [
            {
              product_key: null,
              product_name_raw: "chain link fence",
              spec_text: null,
              quantity: 120,
              quantity_unit: "roll",
              application: null,
              notes: null,
            },
          ],
          status: "unquoted",
          stage: "inquiry",
          stage_updated_at: null,
          created_at: iso("2026-10-01T02:03:04Z"),
          company_name: "Acme Trading",
          quote_count: 2,
          order_count: 1,
          latest_quote_at: iso("2026-10-02T03:04:05Z"),
        },
      ],
      total: 1,
    });
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("SQL 逐字对照：三段结构（相关子查询 + tenant/可见性谓词 + 排序）", async () => {
    resetDb(dbStub({ user: userRow(), inquiries: [] }));
    const spy = onEnv();

    await request("/api/v1/inquiries", userRow(), spy.env);

    const call = dbCallsContaining("FROM cust_inquiries i")[0]!;
    // ① 相关子查询（quote_count / order_count / latest_quote_at）逐字
    expect(call.query).toContain(
      " (SELECT count(*) FROM quote_orders q    WHERE q.tenant_id = i.tenant_id AND q.inquiry_id = i.id) AS quote_count",
    );
    expect(call.query).toContain(
      " (SELECT max(q3.created_at) FROM quote_orders q3    WHERE q3.tenant_id = i.tenant_id AND q3.inquiry_id = i.id)   AS latest_quote_at",
    );
    // ② FROM/JOIN + tenant
    expect(call.query).toContain(" FROM cust_inquiries i JOIN customers c ON i.customer_id = c.id WHERE i.tenant_id = $1");
    // ③ 非管理员：三层可见性谓词（自己 + 租户共享 + 本团队），参数顺序 $2/$3
    expect(call.query).toContain(" AND (i.owner_id = $2 OR i.owner_scope = 'tenant' OR i.team_id = $3)");
    expect(call.params).toEqual(["default", "9", 4]);
    // ④ 排序（按客户归类、客户内时间倒序），且**没有**分页
    expect(call.query).toContain(" ORDER BY i.customer_id, i.created_at DESC");
    expect(call.query).not.toContain("LIMIT");
  });

  it("筛选参数顺序：scope → status → customer_id → stage → channel → date_from → date_to → q", async () => {
    resetDb(dbStub({ user: userRow(), inquiries: [] }));
    const spy = onEnv();

    await request(
      "/api/v1/inquiries?status=quoted&customer_id=3&stage=order&channel=email"
      + "&date_from=2026-10-01&date_to=2026-10-31&q=wire",
      userRow(),
      spy.env,
    );

    const call = dbCallsContaining("FROM cust_inquiries i")[0]!;
    expect(call.query).toContain(" AND (i.owner_id = $2 OR i.owner_scope = 'tenant' OR i.team_id = $3)");
    expect(call.query).toContain(" AND i.status = $4");
    expect(call.query).toContain(" AND i.customer_id = $5");
    expect(call.query).toContain(" AND i.stage = $6");
    expect(call.query).toContain(" AND i.channel = $7");
    expect(call.query).toContain(" AND i.created_at::date >= $8");
    expect(call.query).toContain(" AND i.created_at::date <= $9");
    expect(call.query).toContain(" AND (i.product_name_raw ILIKE $10 OR i.inquiry_no ILIKE $10 OR c.name ILIKE $10)");
    expect(call.params).toEqual([
      "default", "9", 4, "quoted", 3, "order", "email", "2026-10-01", "2026-10-31", "%wire%",
    ]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("管理员：不加可见性谓词（tenant 仍恒在）", async () => {
    resetDb(dbStub({ user: userRow(ADMIN_ROW), inquiries: [] }));
    const spy = onEnv();

    await request("/api/v1/inquiries", userRow(ADMIN_ROW), spy.env);

    const call = dbCallsContaining("FROM cust_inquiries i")[0]!;
    expect(call.query).not.toContain("i.owner_id");
    expect(call.params).toEqual(["default"]);
  });

  it("非法 stage → 422 INVALID_ENUM（allowed 完整阶段清单，不静默空列表）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/inquiries?stage=bogus", userRow(), spy.env);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "invalid_enum_value",
        code: "INVALID_ENUM",
        field: "stage",
        value: "bogus",
        allowed: ["inquiry", "quotation", "order", "shipment", "completed", "closed"],
      },
    });
    expect(dbCallsContaining("FROM cust_inquiries i")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("非法 channel / status / date_from → 422（枚举与日期都先校验）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    expect((await request("/api/v1/inquiries?channel=nope", userRow(), spy.env)).status).toBe(422);
    expect((await request("/api/v1/inquiries?status=nope", userRow(), spy.env)).status).toBe(422);

    const badDate = await request("/api/v1/inquiries?date_from=2026-13-40", userRow(), spy.env);
    expect(badDate.status).toBe(422);
    expect(await badDate.json()).toEqual({
      detail: {
        error: "validation",
        code: "INVALID_DATE",
        field: "date_from",
        detail: "date_from 必须是 YYYY-MM-DD",
      },
    });
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传（query 不丢）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/inquiries?customer_id=7&q=wire", userRow(), spy.env);

    expect(res.status).toBe(200);
    expectForwarded(spy, "/api/v1/inquiries", "?customer_id=7&q=wire");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/inquiries/{inquiry_id}（ws_crm_ext.py:402-479 get_inquiry）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/inquiries/{id}（P3 直连）", () => {
  const QUOTE_ROW: DbRow = {
    id: "21",
    quote_no: "QT-2026-0021",
    customer_id: "3",
    customer_name: "Acme Trading",
    inquiry_id: "11",
    status: "sent",
    currency: "USD",
    total_amount: "1234.50",
    valid_until: null,
    notes: "第一次报价",
    fx_rate: "7.1",
    // quote_orders.fx_rate_date 是 DATE 列（不是 timestamptz）⇒ 内核只出日期
    fx_rate_date: new Date("2026-09-30T00:00:00Z"),
    tax_archive_id: null,
    tax_archive_code: null,
    tax_archive_name: null,
    tax_snapshot: null,
    created_at: new Date("2026-10-02T00:00:00Z"),
    created_by: "9",
    owner_id: "9",
    owner_scope: "private",
    incoterm: "FOB",
    payment_terms: "T/T",
    port_of_loading: "Ningbo",
    port_of_destination: "Hamburg",
    shipping_marks: null,
    country_of_origin: "CN",
    destination_country: "DE",
    destination_region: null,
    carrier: null,
    freight_valid_from: null,
    freight_valid_to: null,
  };

  const ORDER_ROW: DbRow = {
    id: "31",
    order_no: "SO-2026-0031",
    customer_id: "3",
    customer_name: "Acme Trading",
    status: "completed",
    currency: "USD",
    total_amount: "100.00",
    amount_breakdown: null,
    order_date: null,
    delivery_date: null,
    notes: null,
    fx_rate: null,
    fx_rate_date: null,
    created_at: new Date("2026-10-03T00:00:00Z"),
    owner_id: "9",
    owner_scope: "private",
    incoterm: null,
    payment_terms: null,
    port_of_loading: null,
    port_of_destination: null,
    shipping_marks: null,
    country_of_origin: null,
    source_type: "inquiry",
    source_channel: null,
    inquiry_id: "11",
    quote_id: "21",
    confirmed_at: null,
    confirmed_by: null,
    confirmed_source: null,
  };

  const STAGE_ROW: DbRow = {
    id: "41",
    from_stage: "inquiry",
    to_stage: "quotation",
    source_event: "quote_created",
    actor_id: "9",
    note: null,
    created_at: new Date("2026-10-02T00:00:00Z"),
  };

  it("开关 on：200 + 详情形状（quotes/orders/stage_log/counts）+ 全程不经内核", async () => {
    resetDb(dbStub({
      user: userRow(),
      inquiry: inquiryRow(),
      quotes: [QUOTE_ROW],
      quoteItems: [{ count: "3" }],
      quoteOrders: [{ count: "1" }],
      orders: [ORDER_ROW],
      stageLog: [STAGE_ROW],
    }));
    const spy = onEnv();

    const res = await request("/api/v1/inquiries/11", userRow(), spy.env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      company_name: string;
      quotes: DbRow[];
      orders: DbRow[];
      stage_log: DbRow[];
      counts: DbRow;
    };
    expect(body.id).toBe(11);
    expect(body.company_name).toBe("Acme Trading");
    // row_to_quote 32 键 + order_count（金额 float、时间 iso）
    expect(body.quotes[0]).toMatchObject({
      id: 21,
      quote_no: "QT-2026-0021",
      total_amount: 1234.5,
      fx_rate: 7.1,
      fx_rate_date: "2026-09-30",
      created_at: iso("2026-10-02T00:00:00Z"),
      item_count: 3,
      order_count: 1,
      incoterm: "FOB",
    });
    expect(Object.keys(body.quotes[0]!).length).toBe(33);
    // orders[] = row_to_order 全键（orders.ts 行注释写 28、实际 29 键：含 amount_breakdown）
    expect(body.orders[0]).toMatchObject({
      id: 31,
      order_no: "SO-2026-0031",
      total_amount: 100,
      created_at: iso("2026-10-03T00:00:00Z"),
      source_type: "inquiry",
      inquiry_id: 11,
      quote_id: 21,
    });
    expect(Object.keys(body.orders[0]!).length).toBe(29);
    // 详情里的 stage_log[] **带 id**（与 stage-log 端点不同）
    expect(body.stage_log).toEqual([
      {
        id: 41,
        from_stage: "inquiry",
        to_stage: "quotation",
        source_event: "quote_created",
        actor_id: "9",
        note: null,
        created_at: iso("2026-10-02T00:00:00Z"),
      },
    ]);
    expect(body.counts).toEqual({ quotes: 1, orders: 1, open_orders: 0 });
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("SQL 逐字对照：五段查询与排序", async () => {
    resetDb(dbStub({ user: userRow(), inquiry: inquiryRow() }));
    const spy = onEnv();

    await request("/api/v1/inquiries/11", userRow(), spy.env);

    const head = dbCallsContaining("SELECT i.*, c.name AS company_name")[0]!;
    expect(head.query).toContain("JOIN customers c ON i.customer_id = c.id");
    expect(head.query).toContain("WHERE i.tenant_id = $1 AND i.id = $2");
    expect(head.params).toEqual(["default", 11]);

    const quotes = dbCallsContaining("FROM quote_orders WHERE tenant_id=$1 AND inquiry_id=$2")[0]!;
    expect(quotes.query).toContain(" ORDER BY created_at, id");

    const orders = dbCallsContaining("SELECT * FROM orders WHERE tenant_id=$1")[0]!;
    expect(orders.query).toContain(" AND (inquiry_id = $2");
    expect(orders.query).toContain(" OR quote_id IN (SELECT id FROM quote_orders");
    expect(orders.query).toContain(" ORDER BY created_at DESC, id DESC");

    const logs = dbCallsContaining("FROM inquiry_stage_log")[0]!;
    expect(logs.query).toContain(" ORDER BY created_at, id");
  });

  it("别团队/不可见 → 404 INQUIRY_NOT_FOUND（不泄露存在性，不查关联表）", async () => {
    resetDb(dbStub({
      user: userRow(),
      inquiry: inquiryRow({ team_id: "99", owner_id: "77" }),
    }));
    const spy = onEnv();

    const res = await request("/api/v1/inquiries/11", userRow(), spy.env);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: { error: "not_found", code: "INQUIRY_NOT_FOUND" },
    });
    expect(dbCallsContaining("FROM quote_orders WHERE tenant_id=$1 AND inquiry_id=$2")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("查无此询盘 → 404 INQUIRY_NOT_FOUND", async () => {
    resetDb(dbStub({ user: userRow(), inquiry: null }));
    const spy = onEnv();

    const res = await request("/api/v1/inquiries/999", userRow(), spy.env);

    expect(res.status).toBe(404);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/inquiries/11", userRow(), spy.env);

    expect(res.status).toBe(200);
    expectForwarded(spy, "/api/v1/inquiries/11");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/inquiries/{inquiry_id}/stage-log（ws_crm_ext.py:609-646）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/inquiries/{id}/stage-log（P3 直连）", () => {
  it("开关 on（管理员）：200 + items 六键（**无 id**）+ 全程不经内核", async () => {
    resetDb(dbStub({
      user: userRow(ADMIN_ROW),
      stageLogInquiry: { id: "11" },
      stageLog: [
        {
          id: "41",
          from_stage: "inquiry",
          to_stage: "quotation",
          source_event: "quote_created",
          actor_id: "9",
          note: null,
          created_at: new Date("2026-10-02T00:00:00Z"),
        },
      ],
    }));
    const spy = onEnv();

    const res = await request("/api/v1/inquiries/11/stage-log", userRow(ADMIN_ROW), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          from_stage: "inquiry",
          to_stage: "quotation",
          source_event: "quote_created",
          actor_id: "9",
          note: null,
          created_at: iso("2026-10-02T00:00:00Z"),
        },
      ],
    });
    // SQL 逐字：只取 id 做可见性判定；投影列顺序与 ORDER BY 一致
    const probe = dbCallsContaining("SELECT id FROM cust_inquiries")[0]!;
    expect(probe.params).toEqual([11, "default"]);
    const rows = dbCallsContaining("FROM inquiry_stage_log")[0]!;
    expect(rows.query).toContain(
      "SELECT from_stage, to_stage, source_event, actor_id, note, created_at"
      + " FROM inquiry_stage_log WHERE tenant_id=$1 AND inquiry_id=$2 ORDER BY created_at, id",
    );
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("非管理员 → 404（内核现状：只查 id ⇒ _owner_visible 恒失败；逐字保留）", async () => {
    resetDb(dbStub({ user: userRow(), stageLogInquiry: { id: "11" } }));
    const spy = onEnv();

    const res = await request("/api/v1/inquiries/11/stage-log", userRow(), spy.env);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: { error: "not_found", code: "INQUIRY_NOT_FOUND" },
    });
    expect(dbCallsContaining("FROM inquiry_stage_log")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/inquiries/11/stage-log", userRow(ADMIN_ROW), spy.env);

    expect(res.status).toBe(200);
    expectForwarded(spy, "/api/v1/inquiries/11/stage-log");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 401 未鉴权（开关 on 也不打 DB / 内核）与 DB 故障
// ══════════════════════════════════════════════════════════════════════════════

describe("401：未鉴权不触达 DB / 内核", () => {
  const paths = [
    "/api/v1/inquiries",
    "/api/v1/inquiries/11",
    "/api/v1/inquiries/11/stage-log",
  ];

  for (const path of paths) {
    it(`${path} 无 token → 401 Authentication required`, async () => {
      const spy = onEnv();

      const res = await request(path, null, spy.env);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        detail: { error: "unauthorized", message: "Authentication required" },
      });
      expect(dbState.calls).toHaveLength(0);
      expect(spy.fetch).not.toHaveBeenCalled();
    });
  }
});

describe("TS-DB 失败 → 503 db_unavailable", () => {
  it("开关 on 且查询抛错 → 503（不是 500，也不是 502 kernel_unavailable）", async () => {
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [userRow()];
      throw new Error("hyperdrive down");
    });
    const spy = onEnv();

    const res = await request("/api/v1/inquiries", userRow(), spy.env);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "db_unavailable",
      message: DB_UNAVAILABLE_MESSAGE,
      status: 503,
      retryable: true,
    });
    expect(spy.fetch).not.toHaveBeenCalled();
  });
});
