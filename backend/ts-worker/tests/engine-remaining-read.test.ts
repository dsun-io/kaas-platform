/**
 * P3 第七批金标（TS 侧）：GET /api/v1/pricing-data（定价数据矩阵）。
 *
 * 与 Python 侧 backend/worker/tests/test_engine_rpc_remaining_read.py 读同一份 fixture。
 * 要点：供数 = 旧 _pricing_key_items 的同一条 SQL（scope=own 带 customer_id 谓词、all 不带），
 * 时间戳用 tsIsoSql 条件式（内核 fromisoformat 还原后 .isoformat() 与旧路径逐字一致）。
 */
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import {
  CUSTOMER_COST_ITEMS_SQL,
  ENGINE_PRICING_DATA_RPC,
  ENGINE_ROUTE_IDS,
  pricingKeyItemsSql,
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
  facade: Record<string, { sql?: string; params?: unknown[] }>;
  response: Record<string, unknown>;
}

const file = path.join(__dirname, "..", "..", "ts-migration", "golden",
  "engine-pricing-data.fixture.json");
const FIXTURE = JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function userRow(over: Partial<DbRow> = {}): DbRow {
  return {
    id: FIXTURE.actor.id,
    email: "buyer@qa.test",
    display_name: "买家",
    account_type: FIXTURE.actor.account_type,
    role: FIXTURE.actor.role,
    status: "active",
    team_id: FIXTURE.actor.team_id,
    console_access: false,
    plan: "free",
    is_tenant_admin: FIXTURE.actor.is_tenant_admin,
    ...over,
  };
}

/** postgres.js 原始行：id 是字符串、numeric(float 列) 已是 number、时间戳已转文本。 */
function rawCostRows(): DbRow[] {
  return (FIXTURE.datasets.customer_cost_items ?? []).map((row) => ({
    ...row,
    id: String(row.id),
  }));
}

function dbStub(over: (query: string) => DbRow[] | null = () => null) {
  return (query: string): DbRow[] => {
    const custom = over(query);
    if (custom !== null) return custom;
    if (query.includes("FROM users WHERE id")) return [userRow()];
    if (query.includes("FROM customer_cost_items")) return rawCostRows();
    return [];
  };
}

interface KernelCall {
  path: string;
  body: unknown;
}

function kernelSpy(respond?: (call: KernelCall) => Response) {
  const calls: KernelCall[] = [];
  const fetch = vi.fn(async (input: Request | string) => {
    const req = input instanceof Request ? input : new Request(input);
    const url = new URL(req.url);
    const text = await req.clone().text();
    const call: KernelCall = { path: url.pathname, body: text ? JSON.parse(text) : null };
    calls.push(call);
    if (respond) return respond(call);
    return new Response(JSON.stringify({ status: 200, body: FIXTURE.response }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls, fetch };
}

function envWith(flag: Record<string, unknown>, kernelFetch: ReturnType<typeof vi.fn>) {
  return makeTestEnv({ KERNEL: { fetch: kernelFetch as never }, ...flag });
}

const ON = { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.pricingData };

async function call(
  env: ReturnType<typeof makeTestEnv>,
  url: string,
  options: { authorized?: boolean } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorized !== false) {
    headers.set("Authorization", "Bearer " + (await createToken(FIXTURE.actor.id, FIXED_SECRET)));
  }
  return app.request("http://testserver" + url, { method: "GET", headers }, env);
}

beforeEach(() => {
  resetDb(dbStub());
});

describe("P3 第七批 · pricing-data（定价数据矩阵）", () => {
  it("SQL/参数/payload/回放与 fixture 逐字一致（含条件式时间戳）", async () => {
    const kernel = kernelSpy();
    const res = await call(envWith(ON, kernel.fetch),
      "/api/v1/pricing-data?" + FIXTURE.endpoint.query_string);
    expect(res.status).toBe(200);

    const call1 = dbCallsContaining("FROM customer_cost_items")[0]!;
    expect(norm(call1.query)).toBe(norm(FIXTURE.facade.customer_cost_items!.sql!));
    expect(call1.params).toEqual(FIXTURE.facade.customer_cost_items!.params);
    expect(norm(pricingKeyItemsSql(true))).toBe(norm(FIXTURE.facade.customer_cost_items!.sql!));
    // 条件式时间戳（零微秒无小数）+ 旧的恒 6 位写法零残留
    const sql = pricingKeyItemsSql(true);
    expect(sql.split("CASE WHEN to_char(")).toHaveLength(3);
    expect(sql).not.toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.US\"+00:00\"'");
    // 既有 calculate 切片的 SQL 形态不变（回归守卫）：它仍是旧路径那条普通列 SQL
    expect(norm(CUSTOMER_COST_ITEMS_SQL)).toBe(norm(FIXTURE.old_sql[0]!.sql));

    const body = kernel.calls[0]!.body as { request: unknown; datasets: unknown };
    expect(body.request).toEqual(FIXTURE.request);
    expect(body.datasets).toEqual(FIXTURE.datasets);
    expect(await res.json()).toEqual(FIXTURE.response);
  });

  it("scope=all：SQL 不带 customer_id 谓词，params 只有 2 个", async () => {
    const kernel = kernelSpy();
    await call(envWith(ON, kernel.fetch),
      "/api/v1/pricing-data?product_key=field_fence&scope=all");
    const costCall = dbCallsContaining("FROM customer_cost_items")[0]!;
    expect(norm(costCall.query)).not.toContain("customer_id=$3");
    expect(costCall.params).toEqual(["default", "field_fence:"]);
    expect(norm(costCall.query)).toBe(norm(pricingKeyItemsSql(false)));
  });

  it("product_key 为空 ⇒ 不查库、空 dataset（422 判定在内核）", async () => {
    const kernel = kernelSpy(() => new Response(
      JSON.stringify({ status: 422, body: { detail: "product_key is required" } }),
      { status: 200 },
    ));
    const res = await call(envWith(ON, kernel.fetch), "/api/v1/pricing-data");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ detail: "product_key is required" });
    expect(dbCallsContaining("FROM customer_cost_items")).toHaveLength(0);
    const body = kernel.calls[0]!.body as { datasets: { customer_cost_items: unknown[] } };
    expect(body.datasets.customer_cost_items).toEqual([]);
  });

  it("内核 403/404/422 ⇒ 原样回放（业务错误逐字一致）", async () => {
    for (const [status, body] of [
      [403, { detail: "跨客户查看仅管理员可用" }],
      [404, { detail: "未知产品: nope" }],
      [422, { detail: "scope must be own or all" }],
    ] as Array<[number, unknown]>) {
      resetDb(dbStub());
      const kernel = kernelSpy(() => new Response(JSON.stringify({ status, body }), { status: 200 }));
      const res = await call(envWith(ON, kernel.fetch),
        "/api/v1/pricing-data?product_key=field_fence&scope=own");
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
    }
  });

  it("开关 off / 白名单未命中 ⇒ 不取数、旧透传", async () => {
    for (const env of [{}, { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: "quotes.list" }]) {
      resetDb(dbStub());
      const kernel = kernelSpy();
      const res = await call(envWith(env, kernel.fetch), "/api/v1/pricing-data?product_key=field_fence");
      expect(res.status).toBe(200);
      expect(dbCallsContaining("FROM customer_cost_items")).toHaveLength(0);
      expect(kernel.calls[0]!.path).toBe("/api/v1/pricing-data");
    }
  });

  it("匿名 ⇒ 401，不打 DB / 内核", async () => {
    const kernel = kernelSpy();
    const res = await call(envWith(ON, kernel.fetch), "/api/v1/pricing-data?product_key=field_fence",
      { authorized: false });
    expect(res.status).toBe(401);
    expect(dbCallsContaining("FROM customer_cost_items")).toHaveLength(0);
    expect(kernel.calls).toHaveLength(0);
  });

  it("工位闸门 404 ⇒ 原样回放；内核 5xx ⇒ kernel_error；DB 失败 ⇒ 503", async () => {
    const gate = {
      error: "not_found", code: "WORKSTATION_NOT_SUBSCRIBED", workstation: "quotes",
      detail: "该工位未开通，请在“工位开通”里启用",
    };
    resetDb(dbStub());
    const gateKernel = kernelSpy(() => new Response(JSON.stringify(gate), { status: 404 }));
    const gateRes = await call(envWith(ON, gateKernel.fetch),
      "/api/v1/pricing-data?product_key=field_fence");
    expect(gateRes.status).toBe(404);
    expect(await gateRes.json()).toEqual(gate);

    resetDb(dbStub());
    const boomKernel = kernelSpy(() => new Response("boom", { status: 500 }));
    const boomRes = await call(envWith(ON, boomKernel.fetch),
      "/api/v1/pricing-data?product_key=field_fence");
    expect(boomRes.status).toBe(500);
    expect(((await boomRes.json()) as Record<string, unknown>).error).toBe("kernel_error");

    resetDb((query: string) => {
      if (query.includes("FROM users WHERE id")) return [userRow()];
      if (query.includes("FROM customer_cost_items")) throw new Error("connection reset");
      return [];
    });
    const res = await call(envWith(ON, kernelSpy().fetch),
      "/api/v1/pricing-data?product_key=field_fence");
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("db_unavailable");
  });

  it("路由面：GET /api/v1/pricing-data 恰好注册一次；RPC 常量正确", () => {
    const routes = (app.routes as Array<{ method: string; path: string }>).map(
      (r) => r.method.toUpperCase() + " " + r.path,
    );
    expect(routes.filter((r) => r === "GET /api/v1/pricing-data")).toHaveLength(1);
    expect(ENGINE_ROUTE_IDS.pricingData).toBe("pricing-data.list");
    expect(ENGINE_PRICING_DATA_RPC).toBe("/api/v1/internal/engine/quote/pricing-data");
  });
});
