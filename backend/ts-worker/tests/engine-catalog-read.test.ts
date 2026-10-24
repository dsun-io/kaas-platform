/**
 * P3 第六批金标（TS 侧）：4 条「需要内核计算」的只读端点。
 *
 * 1. GET /api/v1/export-quote/products
 * 2. GET /api/v1/quotes/product-name-preference
 * 3. GET /api/v1/export-quote/products/{key}/import-template（**JSON 分支**；format 分支留旧路径）
 * 4. GET /api/v1/export-quote/import/order/template-info
 *
 * 与 Python 侧 backend/worker/tests/test_engine_rpc_catalog_read.py 读同一份 fixture。
 * 要点：产品集合 = 注册表 ∪ 团队可见 tenant_products − 停用 + 团队资料英文名；
 * 产品名偏好用「候选集 + 内核同序首命中」（名字列表由产品定义派生，门面不许复制）。
 */
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import {
  CATALOG_DISABLED_SQL,
  CATALOG_TENANT_PRODUCTS_SQL,
  CUSTOMER_GATE_SQL,
  ENGINE_QUOTE_IMPORT_TEMPLATE_RPC,
  ENGINE_QUOTE_NAME_PREFERENCE_RPC,
  ENGINE_QUOTE_ORDER_TEMPLATE_INFO_RPC,
  ENGINE_QUOTE_PRODUCTS_RPC,
  ENGINE_ROUTE_IDS,
  IMPORT_TEMPLATE_PRODUCT_SQL,
  catalogProfilesSql,
  preferenceCandidatesSql,
} from "../src/routes/engine";
import { createToken } from "../src/session";
import {
  FIXED_SECRET,
  dbCallsContaining,
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
    __dirname, "..", "..", "ts-migration", "golden", "engine-" + name + ".fixture.json",
  );
  return JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
}

const PRODUCTS = loadFixture("products");
const NAME_PREF = loadFixture("product-name-preference");
const IMPORT_TPL = loadFixture("import-template");
const ORDER_TPL = loadFixture("order-template-info");

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

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

/** postgres.js 原始行：int8 是字符串；jsonb 已解码。 */
function rawRows(fixture: Fixture, name: string): DbRow[] {
  return (fixture.datasets[name] ?? []).map((row) => {
    const out: DbRow = { ...row };
    for (const col of ["team_id", "id", "dst_id", "trade_doc_id"]) {
      if (out[col] !== null && out[col] !== undefined) out[col] = String(out[col]);
    }
    return out;
  });
}

function dbStub(fixture: Fixture, over: (query: string) => DbRow[] | null = () => null) {
  return (query: string, _params: unknown[]): DbRow[] => {
    const custom = over(query);
    if (custom !== null) return custom;
    if (query.includes("FROM users WHERE id")) return [userRow(fixture)];
    if (query.includes("FROM tenant_products")) {
      if (query.includes("AND product_key=$2")) return rawRows(IMPORT_TPL, "tenant_products");
      return rawRows(PRODUCTS, "tenant_products");
    }
    if (query.includes("FROM tenant_workstation_products")) {
      return rawRows(PRODUCTS, "tenant_workstation_products");
    }
    if (query.includes("FROM product_profiles")) return rawRows(PRODUCTS, "product_profiles");
    if (query.includes("FROM customers")) return rawRows(NAME_PREF, "customers");
    if (query.includes("FROM quote_order_items")) {
      return rawRows(NAME_PREF, "preference_candidates");
    }
    return [];
  };
}

interface KernelCall {
  path: string;
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
      body: text ? JSON.parse(text) : null,
    };
    calls.push(call);
    if (respond) return respond(call);
    const fixture = call.path === PRODUCTS.rpc ? PRODUCTS
      : call.path === NAME_PREF.rpc ? NAME_PREF
        : call.path === IMPORT_TPL.rpc ? IMPORT_TPL : ORDER_TPL;
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

const ROUTE_IDS = ENGINE_ROUTE_IDS;

async function call(
  env: ReturnType<typeof makeTestEnv>,
  url: string,
  options: { authorized?: boolean } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorized !== false) {
    headers.set("Authorization", "Bearer " + (await createToken(PRODUCTS.actor.id, FIXED_SECRET)));
  }
  return app.request("http://testserver" + url, { method: "GET", headers }, env);
}

beforeEach(() => {
  resetDb(dbStub(PRODUCTS));
});

describe("P3 第六批 · 产品目录（export-quote/products）", () => {
  it("SQL/参数/payload/回放与 fixture 逐字一致（3 个 dataset）", async () => {
    resetDb(dbStub(PRODUCTS));
    const kernel = kernelSpy();
    const res = await call(envWith({ AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.products },
      kernel.fetch), "/api/v1/export-quote/products");
    expect(res.status).toBe(200);

    const tp = dbCallsContaining("FROM tenant_products")[0]!;
    expect(norm(tp.query)).toBe(norm(PRODUCTS.facade.tenant_products!.sql!));
    expect(tp.params).toEqual(PRODUCTS.facade.tenant_products!.params);
    const disabled = dbCallsContaining("FROM tenant_workstation_products")[0]!;
    expect(norm(disabled.query)).toBe(norm(PRODUCTS.facade.tenant_workstation_products!.sql!));
    expect(disabled.params).toEqual(PRODUCTS.facade.tenant_workstation_products!.params);
    const profiles = dbCallsContaining("FROM product_profiles")[0]!;
    expect(norm(profiles.query)).toBe(norm(PRODUCTS.facade.product_profiles!.sql!));
    expect(profiles.params).toEqual(PRODUCTS.facade.product_profiles!.params);
    expect(norm(catalogProfilesSql(false))).toBe(norm(PRODUCTS.facade.product_profiles!.sql!));
    expect(norm(CATALOG_TENANT_PRODUCTS_SQL)).toBe(norm(PRODUCTS.facade.tenant_products!.sql!));
    expect(norm(CATALOG_DISABLED_SQL))
      .toBe(norm(PRODUCTS.facade.tenant_workstation_products!.sql!));

    const body = kernel.calls[0]!.body as { request: unknown; datasets: unknown };
    expect(body.request).toEqual(PRODUCTS.request);
    expect(body.datasets).toEqual(PRODUCTS.datasets);
    expect(await res.json()).toEqual(PRODUCTS.response);
  });

  it("管理员：团队资料查询不带 team_id 谓词", async () => {
    resetDb(dbStub(PRODUCTS, (query) => (
      query.includes("FROM users WHERE id")
        ? [userRow(PRODUCTS, { role: "system_admin", account_type: "internal" })]
        : null)));
    const kernel = kernelSpy();
    await call(envWith({ AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.products },
      kernel.fetch), "/api/v1/export-quote/products");
    const profiles = dbCallsContaining("FROM product_profiles")[0]!;
    expect(norm(profiles.query)).not.toContain("team_id=$2");
    expect(profiles.params).toEqual(["default"]);
  });
});

describe("P3 第六批 · 产品名偏好（quotes/product-name-preference）", () => {
  it("候选集 SQL/参数/payload/回放与 fixture 一致（含 scope 谓词）", async () => {
    resetDb(dbStub(NAME_PREF));
    const kernel = kernelSpy();
    const res = await call(envWith({ AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.namePreference },
      kernel.fetch), "/api/v1/quotes/product-name-preference?customer_id=3&product_key=field_fence");
    expect(res.status).toBe(200);

    const customer = dbCallsContaining("FROM customers")[0]!;
    expect(norm(customer.query)).toBe(norm(NAME_PREF.facade.customers!.sql!));
    expect(customer.params).toEqual(NAME_PREF.facade.customers!.params);
    expect(norm(CUSTOMER_GATE_SQL)).toBe(norm(NAME_PREF.facade.customers!.sql!));
    const candidates = dbCallsContaining("FROM quote_order_items")[0]!;
    expect(norm(candidates.query)).toBe(norm(NAME_PREF.facade.preference_candidates!.sql!));
    expect(candidates.params).toEqual(NAME_PREF.facade.preference_candidates!.params);
    expect(norm(preferenceCandidatesSql(
      " AND (q.owner_id = $4 OR q.owner_scope = 'tenant' OR q.team_id = $5)")))
      .toBe(norm(NAME_PREF.facade.preference_candidates!.sql!));

    const body = kernel.calls[0]!.body as { request: unknown; datasets: unknown };
    expect(body.request).toEqual(NAME_PREF.request);
    expect(body.datasets).toEqual(NAME_PREF.datasets);
    expect(await res.json()).toEqual(NAME_PREF.response);
  });

  it("非法 customer_id / 空 product_key：不查库、空供数，422 判决在内核", async () => {
    for (const url of [
      "/api/v1/quotes/product-name-preference?customer_id=abc&product_key=field_fence",
      "/api/v1/quotes/product-name-preference?product_key=field_fence",
      "/api/v1/quotes/product-name-preference?customer_id=3",
    ]) {
      resetDb(dbStub(NAME_PREF));
      const kernel = kernelSpy(() => new Response(
        JSON.stringify({ status: 422, body: { detail: { error: "validation" } } }),
        { status: 200 },
      ));
      const res = await call(envWith(
        { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.namePreference },
        kernel.fetch), url);
      expect(res.status).toBe(422);
      expect(dbCallsContaining("FROM customers")).toHaveLength(0);
      expect(dbCallsContaining("FROM quote_order_items")).toHaveLength(0);
      const body = kernel.calls[0]!.body as { datasets: Record<string, unknown[]> };
      expect(body.datasets.customers).toEqual([]);
      expect(body.datasets.preference_candidates).toEqual([]);
    }
  });

  it("路由顺序：product-name-preference 必须注册在 /quotes/:quote_id 之前", () => {
    const routes = (app.routes as Array<{ method: string; path: string }>).map(
      (r) => r.method.toUpperCase() + " " + r.path,
    );
    const prefIndex = routes.indexOf("GET /api/v1/quotes/product-name-preference");
    const detailIndex = routes.indexOf("GET /api/v1/quotes/:quote_id");
    expect(prefIndex).toBeGreaterThanOrEqual(0);
    expect(detailIndex).toBeGreaterThan(prefIndex);
  });
});

describe("P3 第六批 · 导入模板（import-template / order template-info）", () => {
  it("import-template JSON 分支：SQL/参数/payload/回放与 fixture 一致", async () => {
    resetDb(dbStub(IMPORT_TPL));
    const kernel = kernelSpy();
    const res = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.importTemplate },
      kernel.fetch), "/api/v1/export-quote/products/field_fence/import-template");
    expect(res.status).toBe(200);
    const rows = dbCallsContaining("FROM tenant_products")[0]!;
    expect(norm(rows.query)).toBe(norm(IMPORT_TPL.facade.tenant_products!.sql!));
    expect(rows.params).toEqual(IMPORT_TPL.facade.tenant_products!.params);
    expect(norm(IMPORT_TEMPLATE_PRODUCT_SQL)).toBe(norm(IMPORT_TPL.facade.tenant_products!.sql!));
    const body = kernel.calls[0]!.body as { request: unknown; datasets: unknown };
    expect(body.request).toEqual(IMPORT_TPL.request);
    expect(body.datasets).toEqual(IMPORT_TPL.datasets);
    expect(await res.json()).toEqual(IMPORT_TPL.response);
  });

  it("import-template 带 format ⇒ 产文件分支走旧路径（不取数、不过供数 RPC）", async () => {
    resetDb(dbStub(IMPORT_TPL));
    const kernel = kernelSpy();
    const res = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.importTemplate },
      kernel.fetch), "/api/v1/export-quote/products/field_fence/import-template?format=csv");
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM tenant_products")).toHaveLength(0);
    expect(kernel.calls).toHaveLength(1);
    expect(kernel.calls[0]!.path).toBe(
      "/api/v1/export-quote/products/field_fence/import-template");
  });

  it("order template-info：3 个 dataset + 回放与 fixture 一致", async () => {
    resetDb(dbStub(ORDER_TPL));
    const kernel = kernelSpy();
    const res = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.orderTemplateInfo },
      kernel.fetch), "/api/v1/export-quote/import/order/template-info?product_keys=field_fence");
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM tenant_products")).toHaveLength(1);
    const body = kernel.calls[0]!.body as { request: unknown; datasets: unknown };
    expect(body.request).toEqual(ORDER_TPL.request);
    expect(body.datasets).toEqual(ORDER_TPL.datasets);
    expect(await res.json()).toEqual(ORDER_TPL.response);
  });
});

describe("P3 第六批 · 回退 / 鉴权 / 异常", () => {
  it("开关 off / 白名单未命中 ⇒ 不取数、旧透传", async () => {
    for (const env of [
      {},
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: "quotes.list" },
    ]) {
      resetDb(dbStub(PRODUCTS));
      const kernel = kernelSpy();
      const res = await call(envWith(env, kernel.fetch), "/api/v1/export-quote/products");
      expect(res.status).toBe(200);
      expect(dbCallsContaining("FROM tenant_products")).toHaveLength(0);
      expect(kernel.calls[0]!.path).toBe("/api/v1/export-quote/products");
    }
  });

  it("匿名 ⇒ 401，不打 DB / 内核", async () => {
    resetDb(dbStub(PRODUCTS));
    const kernel = kernelSpy();
    const res = await call(envWith({ AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.products },
      kernel.fetch), "/api/v1/export-quote/products", { authorized: false });
    expect(res.status).toBe(401);
    expect(dbCallsContaining("FROM tenant_products")).toHaveLength(0);
    expect(kernel.calls).toHaveLength(0);
  });

  it("内核业务 4xx（404 产品不存在）⇒ 原样回放", async () => {
    resetDb(dbStub(NAME_PREF));
    const body = { detail: { error: "not_found", code: "PRODUCT_NOT_FOUND", message: "x" } };
    const kernel = kernelSpy(
      () => new Response(JSON.stringify({ status: 404, body }), { status: 200 }));
    const res = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.namePreference },
      kernel.fetch), "/api/v1/quotes/product-name-preference?customer_id=3&product_key=nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(body);
  });

  it("工位闸门 404 ⇒ 原样回放；内核 5xx ⇒ kernel_error；DB 失败 ⇒ 503", async () => {
    const gate = {
      error: "not_found", code: "WORKSTATION_NOT_SUBSCRIBED",
      workstation: "quotes", detail: "该工位未开通，请在“工位开通”里启用",
    };
    resetDb(dbStub(PRODUCTS));
    const gateKernel = kernelSpy(() => new Response(JSON.stringify(gate), { status: 404 }));
    const gateRes = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.products },
      gateKernel.fetch), "/api/v1/export-quote/products");
    expect(gateRes.status).toBe(404);
    expect(await gateRes.json()).toEqual(gate);

    resetDb(dbStub(PRODUCTS));
    const boomKernel = kernelSpy(() => new Response("boom", { status: 500 }));
    const boomRes = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.products },
      boomKernel.fetch), "/api/v1/export-quote/products");
    expect(boomRes.status).toBe(500);
    expect(((await boomRes.json()) as Record<string, unknown>).error).toBe("kernel_error");

    resetDb((query: string) => {
      if (query.includes("FROM users WHERE id")) return [userRow(PRODUCTS)];
      if (query.includes("FROM tenant_products")) throw new Error("connection reset");
      return [];
    });
    const res = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ROUTE_IDS.products },
      kernelSpy().fetch), "/api/v1/export-quote/products");
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("db_unavailable");
  });

  it("路由面：4 个 GET 各恰好注册一次；RPC 常量正确", () => {
    const routes = (app.routes as Array<{ method: string; path: string }>).map(
      (r) => r.method.toUpperCase() + " " + r.path,
    );
    for (const path of [
      "GET /api/v1/export-quote/products",
      "GET /api/v1/export-quote/products/:product_key/import-template",
      "GET /api/v1/export-quote/import/order/template-info",
      "GET /api/v1/quotes/product-name-preference",
    ]) {
      expect(routes.filter((r) => r === path)).toHaveLength(1);
    }
    expect(ROUTE_IDS.products).toBe("export-quote.products");
    expect(ROUTE_IDS.namePreference).toBe("quotes.product-name-preference");
    expect(ROUTE_IDS.importTemplate).toBe("export-quote.import-template");
    expect(ROUTE_IDS.orderTemplateInfo).toBe("export-quote.order-template-info");
    expect(ENGINE_QUOTE_PRODUCTS_RPC).toBe("/api/v1/internal/engine/quote/products");
    expect(ENGINE_QUOTE_NAME_PREFERENCE_RPC)
      .toBe("/api/v1/internal/engine/quote/product-name-preference");
    expect(ENGINE_QUOTE_IMPORT_TEMPLATE_RPC)
      .toBe("/api/v1/internal/engine/quote/import-template");
    expect(ENGINE_QUOTE_ORDER_TEMPLATE_INFO_RPC)
      .toBe("/api/v1/internal/engine/quote/order-template-info");
  });
});
