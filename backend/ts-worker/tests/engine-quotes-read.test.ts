/**
 * P3 第四批切片金标（TS 侧）：GET /api/v1/quotes（列表）+ /quotes/{quote_id}（详情）
 * 「门面供数 → 内核纯投影 → 原样回放」。
 *
 * 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8；与 Python 侧
 * backend/worker/tests/test_engine_rpc_quotes_read.py 读**同一份** fixture：
 * - TS 断言：门面发出的 SQL/参数 == fixture.facade、发给内核的 {request,actor,datasets}
 *   == fixture 对应段、回放 body == fixture.response；
 * - Python 断言：旧路径（自取数）响应/SQL == fixture、新路径（供数）== fixture.response。
 *
 * 本切片要点：
 * - quote_orders 用显式列（BIGINT/NUMERIC 归一；时间戳用 tsIsoSql 条件式，DATE 用 to_char）；
 * - 可见性谓词下推（非管理员三条 owner/tenant/team），内核再用 can_view 判一次（防御纵深）；
 * - 列表的行数/锁定查询只在 ids 非空时发；详情第二查只在第一查无行时发（C 类形态）。
 */
import fs from "node:fs";
import path from "node:path";

import { jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import {
  ENGINE_QUOTES_DETAIL_RPC,
  ENGINE_QUOTES_LIST_RPC,
  ENGINE_ROUTE_IDS,
  ORDERS_LOCK_DETAIL_SQL,
  ORDERS_LOCKED_LIST_SQL,
  QUOTE_ITEM_COLUMNS,
  QUOTE_ITEM_COUNTS_SQL,
  QUOTE_ORDER_COLUMNS,
  QUOTE_ORDERS_ITEMS_DETAIL_SQL,
  TRADE_DOCS_LOCK_DETAIL_SQL,
  TRADE_DOCS_LOCKED_LIST_SQL,
  dateIsoSql,
  quoteItemDatasetRow,
  quoteOrderDatasetRow,
  quoteOrdersCountSql,
  quoteOrdersDetailSql,
  quoteOrdersListSql,
  tsIsoSql,
} from "../src/routes/engine";
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

interface Fixture {
  endpoint: { method: string; path: string; query_string: string };
  rpc: string;
  request: Record<string, unknown>;
  actor: {
    id: number;
    account_type: string;
    role: string;
    team_id: number | null;
    is_tenant_admin: boolean;
  };
  datasets: Record<string, DbRow[]>;
  old_sql: Array<{ sql: string; params: unknown[] }>;
  facade: Record<string, { sql?: string; params?: unknown[]; columns?: string }>;
  response: Record<string, unknown>;
}

function loadFixture(name: string): Fixture {
  const file = path.join(
    __dirname, "..", "..", "ts-migration", "golden", "engine-quotes-" + name + ".fixture.json",
  );
  return JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
}

const LIST = loadFixture("list");
const DETAIL = loadFixture("detail");

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** users 行（与 fixture.actor 对齐；requireUser 走 users 查询装载）。 */
function userRow(fixture: Fixture, over: Partial<DbRow> = {}): DbRow {
  return {
    id: fixture.actor.id,
    email: "buyer@qa.test",
    display_name: "买家",
    account_type: fixture.actor.account_type,
    role: fixture.actor.role,
    status: "active",
    team_id: fixture.actor.team_id,
    console_access: false,
    plan: "free",
    is_tenant_admin: fixture.actor.is_tenant_admin,
    ...over,
  };
}

const BIGINT_COLS = ["id", "customer_id", "inquiry_id", "tax_archive_id", "team_id"];
const NUMERIC_COLS = ["total_amount", "fx_rate"];

/** postgres.js 原始行形状：int8/numeric 是字符串、timestamptz/DATE 已由 SQL 转成文本。 */
function rawQuoteRow(row: DbRow): DbRow {
  const out: DbRow = { ...row };
  for (const col of BIGINT_COLS.concat(NUMERIC_COLS)) {
    if (out[col] !== null && out[col] !== undefined) out[col] = String(out[col]);
  }
  return out;
}

function rawItemRow(row: DbRow): DbRow {
  const out: DbRow = { ...row };
  for (const col of ["id", "quote_order_id", "sku_id",
    "qty", "unit_price", "line_amount",
    "cost_override", "price_override", "weight_override", "volume_override"]) {
    if (out[col] !== null && out[col] !== undefined) out[col] = String(out[col]);
  }
  return out;
}

/** 按 SQL 片段路由的 DB 桩（列表 / 详情两套返回；values 模拟 postgres.js 原始类型）。 */
function dbStub(fixture: Fixture, over: (query: string) => DbRow[] | null = () => null) {
  return (query: string, params: unknown[]): DbRow[] => {
    const custom = over(query);
    if (custom !== null) return custom;
    if (query.includes("FROM users WHERE id")) return [userRow(fixture)];
    if (query.includes("FROM quote_orders")) {
      if (query.includes("COUNT(*)")) {
        return (fixture.datasets.quote_orders_total ?? []).map((row) => ({
          count: String(row.count),
        }));
      }
      return (fixture.datasets.quote_orders ?? []).map(rawQuoteRow);
    }
    if (query.includes("FROM quote_order_items")) {
      if (query.includes("GROUP BY quote_order_id")) {
        return (fixture.datasets.quote_order_item_counts ?? []).map((row) => ({
          quote_order_id: String(row.quote_order_id),
          n: String(row.n),
        }));
      }
      return (fixture.datasets.quote_order_items ?? []).map(rawItemRow);
    }
    if (query.includes("FROM trade_docs")) {
      if (query.includes("SELECT 1 AS locked")) {
        return (fixture.datasets.trade_docs_locked ?? []).map(() => ({ locked: 1 }));
      }
      return (fixture.datasets.trade_docs_locked ?? []).map((row) => ({
        quote_id: String(row.quote_id),
      }));
    }
    if (query.includes("FROM orders")) {
      if (query.includes("SELECT 1 AS locked")) {
        return (fixture.datasets.orders_locked ?? []).map(() => ({ locked: 1 }));
      }
      return (fixture.datasets.orders_locked ?? []).map((row) => ({
        quote_id: String(row.quote_id),
      }));
    }
    return [];
  };
}

interface KernelCall {
  path: string;
  method: string;
  authorization: string;
  body: unknown;
}

function kernelSpy(
  respond?: (call: KernelCall) => Response,
): { calls: KernelCall[]; fetch: ReturnType<typeof vi.fn> } {
  const calls: KernelCall[] = [];
  const fetch = vi.fn(async (input: Request | string) => {
    const req = input instanceof Request ? input : new Request(input);
    const url = new URL(req.url);
    const text = await req.clone().text();
    const call: KernelCall = {
      path: url.pathname,
      method: req.method,
      authorization: req.headers.get("Authorization") ?? "",
      body: text ? JSON.parse(text) : null,
    };
    calls.push(call);
    if (respond) return respond(call);
    const fixture = call.path === LIST.rpc ? LIST : DETAIL;
    return new Response(JSON.stringify({ status: 200, body: fixture.response }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls, fetch };
}

function envWith(flag: Record<string, unknown>, kernelFetch: ReturnType<typeof vi.fn>) {
  return makeTestEnv({ KERNEL: { fetch: kernelFetch as never }, ...flag });
}

const ON_LIST = { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.quotesList };
const ON_DETAIL = { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.quotesDetail };

async function callList(
  env: ReturnType<typeof makeTestEnv>,
  options: { authorized?: boolean; url?: string } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorized !== false) {
    headers.set("Authorization", "Bearer " + (await createToken(LIST.actor.id, FIXED_SECRET)));
  }
  const url = options.url
    ?? "http://testserver" + LIST.endpoint.path + "?" + LIST.endpoint.query_string;
  return app.request(url, { method: "GET", headers }, env);
}

async function callDetail(
  env: ReturnType<typeof makeTestEnv>,
  options: { authorized?: boolean; url?: string } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorized !== false) {
    headers.set("Authorization", "Bearer " + (await createToken(DETAIL.actor.id, FIXED_SECRET)));
  }
  return app.request(
    options.url ?? "http://testserver" + DETAIL.endpoint.path,
    { method: "GET", headers },
    env,
  );
}

beforeEach(() => {
  resetDb(dbStub(LIST));
});

describe("P3 quotes 列表 · 开关 on：TS 供数 → 内核纯投影 → 原样回放", () => {
  beforeEach(() => {
    resetDb(dbStub(LIST));
  });

  it("门面发出的每条 SQL/参数与供数契约逐字一致（fixture.facade 锁定）", async () => {
    const kernel = kernelSpy();
    const res = await callList(envWith(ON_LIST, kernel.fetch));
    expect(res.status).toBe(200);

    // 常量/构造器与 fixture 同源
    expect(QUOTE_ORDER_COLUMNS).toBe(LIST.facade.quote_orders!.columns);
    const listQuery = dbCallsContaining("FROM quote_orders").find((c) =>
      c.query.includes("ORDER BY created_at DESC"))!;
    expect(norm(listQuery.query)).toBe(LIST.facade.quote_orders!.sql);
    expect(listQuery.params).toEqual(LIST.facade.quote_orders!.params);
    expect(norm(dbCallsContaining("COUNT(*)")[0]!.query))
      .toBe(LIST.facade.quote_orders_total!.sql);
    expect(dbCallsContaining("COUNT(*)")[0]!.params)
      .toEqual(LIST.facade.quote_orders_total!.params);
    expect(norm(dbCallsContaining("GROUP BY quote_order_id")[0]!.query))
      .toBe(LIST.facade.quote_order_item_counts!.sql);
    expect(dbCallsContaining("GROUP BY quote_order_id")[0]!.params)
      .toEqual(LIST.facade.quote_order_item_counts!.params);
    expect(norm(dbCallsContaining("FROM trade_docs")[0]!.query))
      .toBe(LIST.facade.trade_docs_locked!.sql);
    expect(dbCallsContaining("FROM trade_docs")[0]!.params)
      .toEqual(LIST.facade.trade_docs_locked!.params);
    expect(norm(dbCallsContaining("FROM orders")[0]!.query))
      .toBe(LIST.facade.orders_locked!.sql);
    expect(dbCallsContaining("FROM orders")[0]!.params)
      .toEqual(LIST.facade.orders_locked!.params);
    // 构造器同源（LIMIT/OFFSET 依 cond 参数个数推导）
    const cond = LIST.facade.quote_orders!.sql!.split(" WHERE ")[1]!
      .split(" ORDER BY ")[0]!;
    expect(quoteOrdersCountSql(cond)).toBe(LIST.facade.quote_orders_total!.sql);
    expect(quoteOrdersListSql(cond, LIST.facade.quote_orders_total!.params!.length))
      .toBe(LIST.facade.quote_orders!.sql);
  });

  it("发给内核的 payload 与 fixture 逐字段一致（request/actor/datasets）", async () => {
    const kernel = kernelSpy();
    await callList(envWith(ON_LIST, kernel.fetch));
    expect(kernel.calls).toHaveLength(1);
    const kernelCall = kernel.calls[0]!;
    expect(kernelCall.path).toBe(ENGINE_QUOTES_LIST_RPC);
    expect(ENGINE_QUOTES_LIST_RPC).toBe(LIST.rpc);
    const body = kernelCall.body as { request: unknown; actor: unknown; datasets: unknown };
    expect(body.request).toEqual(LIST.request);
    expect(body.actor).toEqual({
      id: LIST.actor.id,
      tenant_id: "default",
      team_id: LIST.actor.team_id,
      role: LIST.actor.role,
      account_type: LIST.actor.account_type,
      is_tenant_admin: LIST.actor.is_tenant_admin,
    });
    expect(body.datasets).toEqual(LIST.datasets);
  });

  it("内部 JWT 沿用 mintInternalJwt 口径：HS256/同一 secret/60s + kaas_internal claim", async () => {
    const kernel = kernelSpy();
    await callList(envWith(ON_LIST, kernel.fetch));
    const bearer = kernel.calls[0]!.authorization.replace(/^Bearer /, "");
    const { payload } = await jwtVerify(bearer, new TextEncoder().encode(FIXED_SECRET), {
      algorithms: ["HS256"],
    });
    expect(payload.kaas_internal).toBe("engine");
    expect(payload.sub).toBe(String(LIST.actor.id));
    expect(payload.team_id).toBe(LIST.actor.team_id);
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(60);
  });

  it("回放 body == fixture.response（逐字段）", async () => {
    const kernel = kernelSpy();
    const res = await callList(envWith(ON_LIST, kernel.fetch));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIST.response);
  });

  it("时间戳口径：零微秒无小数 / 非零 6 位（门面 SQL 用条件式 tsIsoSql，DATE 用 to_char）", () => {
    const columns = LIST.facade.quote_orders!.columns!;
    expect(columns.split("CASE WHEN to_char(")).toHaveLength(4);   // valid_until/created_at/updated_at
    expect(columns).toContain(tsIsoSql("valid_until"));
    expect(columns).toContain(tsIsoSql("created_at"));
    expect(columns).toContain(tsIsoSql("updated_at"));
    expect(columns).toContain(dateIsoSql("fx_rate_date"));
    expect(columns).toContain(dateIsoSql("freight_valid_from"));
    expect(columns).toContain(dateIsoSql("freight_valid_to"));
    // 旧的恒 6 位写法不得残留
    expect(columns).not.toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.US\"+00:00\"'");
    // fixture 同时覆盖两种口径
    const items = LIST.response.items as Array<Record<string, unknown>>;
    const item = items[0]!;
    expect(String(item.created_at)).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
    expect(String(item.valid_until)).toMatch(/T\d{2}:\d{2}:\d{2}\+00:00$/);
  });

  it("非管理员：可见性谓词下推 owner/tenant/team 三条（与 _scope_sql 同义）", async () => {
    const kernel = kernelSpy();
    await callList(envWith(ON_LIST, kernel.fetch));
    const cond = LIST.facade.quote_orders!.sql!;
    expect(cond).toContain("(owner_id = $2 OR owner_scope = 'tenant' OR team_id = $3)");
    // WHERE 参数 = ["default", owner_id, team_id]，最后两位是 LIMIT/OFFSET
    expect(LIST.facade.quote_orders!.params!.slice(0, -2)).toEqual(["default", "5", 2]);
    expect(LIST.facade.quote_orders!.params!.slice(-2)).toEqual([20, 0]);
    expect(kernel.calls).toHaveLength(1);
  });

  it("管理员：不加可见性谓词（SELECT 里只有 tenant_id 条件）", async () => {
    resetDb(dbStub(LIST, (query) =>
      query.includes("FROM users WHERE id")
        ? [userRow(LIST, { role: "system_admin", account_type: "internal" })]
        : null));
    const kernel = kernelSpy();
    const res = await callList(envWith(ON_LIST, kernel.fetch));
    expect(res.status).toBe(200);
    const listQuery = dbCallsContaining("FROM quote_orders")
      .find((c) => c.query.includes("ORDER BY created_at DESC"))!;
    // SELECT 列里当然有 owner_id 列；这里断言的是**WHERE 谓词**没有作用域片段
    expect(norm(listQuery.query)).not.toContain("owner_id = $");
    expect(norm(listQuery.query)).not.toContain("owner_scope = 'tenant'");
    expect(listQuery.params).toEqual(["default", 20, 0]);
  });

  it("当前页为空 ⇒ 行数/锁定三条查询都不发（与旧 handler 同一条件）", async () => {
    resetDb(dbStub(LIST, (query) => {
      if (query.includes("FROM quote_orders") && !query.includes("COUNT(*)")) return [];
      return null;
    }));
    const kernel = kernelSpy();
    const res = await callList(envWith(ON_LIST, kernel.fetch));
    expect(res.status).toBe(200);
    expect(dbCallsContaining("GROUP BY quote_order_id")).toHaveLength(0);
    expect(dbCallsContaining("FROM trade_docs")).toHaveLength(0);
    expect(dbCallsContaining("FROM orders")).toHaveLength(0);
  });

  it("内核业务 4xx（如 422 非法 query）⇒ 原样回放该状态码与 body", async () => {
    const detail = {
      detail: [{
        type: "int_parsing", loc: ["query", "page"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: "abc",
      }],
    };
    const kernel = kernelSpy(
      () => new Response(JSON.stringify({ status: 422, body: detail }), { status: 200 }),
    );
    const res = await callList(
      envWith(ON_LIST, kernel.fetch),
      { url: "http://testserver/api/v1/quotes?page=abc" },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(detail);
    // query 原样传给内核（解析/校验在内核，门面不写第二份）
    const body = kernel.calls[0]!.body as { request: { query: Record<string, unknown> } };
    expect(body.request.query.page).toBe("abc");
  });
});

describe("P3 quotes 详情 · 开关 on：TS 供数 → 内核纯投影 → 原样回放", () => {
  beforeEach(() => {
    resetDb(dbStub(DETAIL));
  });

  it("SQL/参数/payload/回放全部与 fixture 一致（含 C 类条件取数）", async () => {
    const kernel = kernelSpy();
    const res = await callDetail(envWith(ON_DETAIL, kernel.fetch));
    expect(res.status).toBe(200);

    expect(QUOTE_ITEM_COLUMNS).toBe(DETAIL.facade.quote_order_items_detail!.columns);
    const rowQuery = dbCallsContaining("FROM quote_orders")[0]!;
    expect(norm(rowQuery.query)).toBe(DETAIL.facade.quote_orders_detail!.sql);
    expect(rowQuery.params).toEqual(DETAIL.facade.quote_orders_detail!.params);
    expect(quoteOrdersDetailSql(norm(rowQuery.query).split(" WHERE ")[1]!))
      .toBe(DETAIL.facade.quote_orders_detail!.sql);
    const itemQuery = dbCallsContaining("FROM quote_order_items")[0]!;
    expect(norm(itemQuery.query)).toBe(DETAIL.facade.quote_order_items_detail!.sql);
    expect(itemQuery.params).toEqual(DETAIL.facade.quote_order_items_detail!.params);
    expect(norm(dbCallsContaining("FROM trade_docs")[0]!.query))
      .toBe(DETAIL.facade.trade_docs_lock_detail!.sql);
    expect(norm(dbCallsContaining("FROM orders")[0]!.query))
      .toBe(DETAIL.facade.orders_lock_detail!.sql);
    // 常量导出可直接对照（防止被单独改掉）
    expect(TRADE_DOCS_LOCK_DETAIL_SQL).toBe(DETAIL.facade.trade_docs_lock_detail!.sql);
    expect(ORDERS_LOCK_DETAIL_SQL).toBe(DETAIL.facade.orders_lock_detail!.sql);
    expect(QUOTE_ORDERS_ITEMS_DETAIL_SQL).toBe(DETAIL.facade.quote_order_items_detail!.sql);
    expect(QUOTE_ITEM_COUNTS_SQL).toBe(LIST.facade.quote_order_item_counts!.sql);
    expect(TRADE_DOCS_LOCKED_LIST_SQL).toBe(LIST.facade.trade_docs_locked!.sql);
    expect(ORDERS_LOCKED_LIST_SQL).toBe(LIST.facade.orders_locked!.sql);

    const body = kernel.calls[0]!.body as { request: unknown; datasets: unknown };
    expect(body.request).toEqual(DETAIL.request);
    expect(body.datasets).toEqual(DETAIL.datasets);
    expect(await res.json()).toEqual(DETAIL.response);
  });

  it("详情不存在（datasets.quote_orders 为空）⇒ 不查行项/锁定（同旧路径 404 前不发查询）", async () => {
    resetDb(dbStub(DETAIL, (query) =>
      query.includes("FROM quote_orders") ? [] : null));
    const kernel = kernelSpy();
    const res = await callDetail(envWith(ON_DETAIL, kernel.fetch));
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM quote_order_items")).toHaveLength(0);
    expect(dbCallsContaining("FROM trade_docs")).toHaveLength(0);
    const body = kernel.calls[0]!.body as { datasets: { quote_orders: unknown[] } };
    expect(body.datasets.quote_orders).toEqual([]);
  });

  it("已有下游单证锁定 ⇒ 不再查 orders（C 类条件取数）", async () => {
    resetDb(dbStub(DETAIL, (query) =>
      query.includes("SELECT 1 AS locked FROM trade_docs") ? [{ locked: 1 }] : null));
    const kernel = kernelSpy();
    const res = await callDetail(envWith(ON_DETAIL, kernel.fetch));
    expect(res.status).toBe(200);
    expect(dbCallsContaining("SELECT 1 AS locked FROM trade_docs")).toHaveLength(1);
    expect(dbCallsContaining("SELECT 1 AS locked FROM orders")).toHaveLength(0);
    const body = kernel.calls[0]!.body as { datasets: { orders_locked: unknown[] } };
    expect(body.datasets.orders_locked).toEqual([]);
  });

  it("非整数 quote_id ⇒ 交旧路径裁决（不自拼第二份 422）", async () => {
    const kernel = kernelSpy();
    const res = await callDetail(
      envWith(ON_DETAIL, kernel.fetch),
      { url: "http://testserver/api/v1/quotes/abc" },
    );
    expect(res.status).toBe(200);
    expect(kernel.calls).toHaveLength(1);
    expect(kernel.calls[0]!.path).toBe("/api/v1/quotes/abc");
  });
});

describe("P3 quotes 切片 · 回退 / 鉴权 / 异常", () => {
  it("AUTH_DB_SPLIT 缺失（默认 off）⇒ 不取数、原样透传旧端点", async () => {
    const kernel = kernelSpy();
    const res = await callList(envWith({}, kernel.fetch));
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM quote_orders")).toHaveLength(0);
    expect(kernel.calls[0]!.path).toBe("/api/v1/quotes");
  });

  it("白名单未命中 ⇒ 旧透传（列表/详情都一样）", async () => {
    const kernel = kernelSpy();
    await callList(envWith({ AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: "export-quote.calculate" },
      kernel.fetch));
    await callDetail(envWith({ AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: "export-quote.calculate" },
      kernel.fetch));
    expect(kernel.calls.map((c) => c.path)).toEqual(["/api/v1/quotes", "/api/v1/quotes/11"]);
    expect(dbCallsContaining("FROM quote_orders")).toHaveLength(0);
  });

  it("匿名请求 ⇒ 401，不打到 DB / 内核", async () => {
    const kernel = kernelSpy();
    const res = await callList(envWith(ON_LIST, kernel.fetch), { authorized: false });
    expect(res.status).toBe(401);
    expect(dbCallsContaining("FROM quote_orders")).toHaveLength(0);
    expect(kernel.calls).toHaveLength(0);
  });

  it("工位订阅闸门（内核中间件 404，非信封形状）⇒ 原样回放", async () => {
    const gate = {
      error: "not_found",
      code: "WORKSTATION_NOT_SUBSCRIBED",
      workstation: "quotes",
      detail: "该工位未开通，请在“工位开通”里启用",
    };
    const kernel = kernelSpy(() => new Response(JSON.stringify(gate), { status: 404 }));
    const res = await callList(envWith(ON_LIST, kernel.fetch));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(gate);
  });

  it("内核 5xx ⇒ kernel_error；TS 供数失败 ⇒ 503 db_unavailable", async () => {
    const kernel = kernelSpy(() => new Response("boom", { status: 500 }));
    const res = await callList(envWith(ON_LIST, kernel.fetch));
    expect(res.status).toBe(500);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("kernel_error");

    resetDb((query: string) => {
      if (query.includes("FROM users WHERE id")) return [userRow(LIST)];
      if (query.includes("FROM quote_orders")) throw new Error("connection reset");
      return [];
    });
    const kernel2 = kernelSpy();
    const res2 = await callList(envWith(ON_LIST, kernel2.fetch));
    expect(res2.status).toBe(503);
    expect(((await res2.json()) as Record<string, unknown>).error).toBe("db_unavailable");
  });

  it("路由面：两个 GET 各恰好注册一次", () => {
    const routes = (app.routes as Array<{ method: string; path: string }>).map(
      (r) => r.method.toUpperCase() + " " + r.path,
    );
    expect(routes.filter((r) => r === "GET /api/v1/quotes")).toHaveLength(1);
    expect(routes.filter((r) => r === "GET /api/v1/quotes/:quote_id")).toHaveLength(1);
    expect(ENGINE_ROUTE_IDS.quotesList).toBe("quotes.list");
    expect(ENGINE_ROUTE_IDS.quotesDetail).toBe("quotes.detail");
    expect(ENGINE_QUOTES_LIST_RPC).toBe("/api/v1/internal/engine/quotes/list");
    expect(ENGINE_QUOTES_DETAIL_RPC).toBe("/api/v1/internal/engine/quotes/detail");
    // dataset 行归一函数：字符串 int8 → number（fixture 口径）
    expect(quoteOrderDatasetRow({ id: "11", team_id: "2", total_amount: "100.00" }).id).toBe(11);
    expect(quoteItemDatasetRow({ id: "1", qty: "10.0" }).qty).toBe(10);
  });
});
