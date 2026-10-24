/**
 * P2 首个端到端切片（TS 侧）金标测试：门面「供数 → 内核纯算 → 原样回放」。
 *
 * 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8；与 Python 侧
 * backend/worker/tests/test_engine_rpc_quote_calculate.py 读**同一份** fixture：
 * - TS 断言：门面发出的 SQL == fixture.sql、绑定参数 == fixture.sql_params、
 *   发给内核的 {request,actor,datasets} == fixture 对应段、回放 body == fixture.response；
 * - Python 断言：旧路径（自取数）== 新路径（供数）== fixture.response。
 * ⇒ 任一侧供数/契约漂移都会让 CI 变红（fixture 禁止在测试里自更新）。
 */
import fs from "node:fs";
import path from "node:path";

import { jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import {
  CUSTOMER_COST_ITEMS_SQL,
  ENGINE_QUOTE_CALCULATE_RPC,
  TENANT_PRODUCTS_SQL,
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

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "ts-migration", "golden", "engine-quote-calculate.fixture.json"),
    "utf8",
  ),
) as {
  endpoint: { method: string; path: string };
  rpc: string;
  request: Record<string, unknown>;
  actor: { id: number; account_type: string; role: string; team_id: number; is_tenant_admin: boolean };
  datasets: { tenant_products: DbRow[]; customer_cost_items: DbRow[] };
  sql: { tenant_products: string; customer_cost_items: string };
  sql_params: { tenant_products: unknown[]; customer_cost_items: unknown[] };
  response: Record<string, unknown>;
};

const CALC_PATH = FIXTURE.endpoint.path;

/** 用户行（与 fixture.actor 对齐；requireUser 走 users 查询装载）。 */
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

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** 按 SQL 片段路由的 DB 桩；users 查询永远返回当前用户。 */
function dbStub(over: (query: string) => DbRow[] | null = () => null): (query: string) => DbRow[] {
  return (query: string): DbRow[] => {
    const custom = over(query);
    if (custom !== null) return custom;
    if (query.includes("FROM users WHERE id")) return [userRow()];
    if (query.includes("FROM tenant_products")) return FIXTURE.datasets.tenant_products;
    if (query.includes("FROM customer_cost_items")) return FIXTURE.datasets.customer_cost_items;
    return [];
  };
}

interface KernelCall {
  path: string;
  method: string;
  authorization: string;
  body: unknown;
}

/** 内核替身：记录调用；返回 {status, body} 信封（默认 200 + fixture.response）。 */
function kernelSpy(
  respond: (call: KernelCall) => Response = () =>
    new Response(JSON.stringify({ status: 200, body: FIXTURE.response }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
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
    return respond(call);
  });
  return { calls, fetch };
}

function envWith(flag: Record<string, unknown>, kernelFetch: ReturnType<typeof vi.fn>) {
  return makeTestEnv({ KERNEL: { fetch: kernelFetch as never }, ...flag });
}

const ON = { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: "export-quote.calculate" };

async function post(
  env: ReturnType<typeof makeTestEnv>,
  body: unknown = FIXTURE.request,
  authorized = true,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorized) {
    headers.set(
      "Authorization",
      "Bearer " + (await createToken(FIXTURE.actor.id, FIXED_SECRET)),
    );
  }
  return app.request(CALC_PATH, { method: "POST", headers, body: JSON.stringify(body) }, env);
}

beforeEach(() => {
  resetDb(dbStub());
});

describe("P2 切片 · 开关 on：TS 供数 → 内核纯算 → 原样回放", () => {
  it("门面发出的 SQL/参数与 Python 旧路径逐字一致（fixture 锁）", async () => {
    const kernel = kernelSpy();
    const res = await post(envWith(ON, kernel.fetch));

    expect(res.status).toBe(200);
    const tenantCalls = dbCallsContaining("FROM tenant_products");
    const costCalls = dbCallsContaining("FROM customer_cost_items");
    expect(tenantCalls).toHaveLength(1);
    expect(costCalls).toHaveLength(1);
    expect(norm(tenantCalls[0]!.query)).toBe(FIXTURE.sql.tenant_products);
    expect(tenantCalls[0]!.params).toEqual(FIXTURE.sql_params.tenant_products);
    expect(norm(costCalls[0]!.query)).toBe(FIXTURE.sql.customer_cost_items);
    expect(costCalls[0]!.params).toEqual(FIXTURE.sql_params.customer_cost_items);
    // SQL 常量与 fixture 同源（防止常量被单独改掉而测试只比较「实际发生」的调用）
    expect(TENANT_PRODUCTS_SQL).toBe(FIXTURE.sql.tenant_products);
    expect(CUSTOMER_COST_ITEMS_SQL).toBe(FIXTURE.sql.customer_cost_items);
  });

  it("发给内核的 payload 与 fixture 逐字段一致（request/actor/datasets）", async () => {
    const kernel = kernelSpy();
    await post(envWith(ON, kernel.fetch));

    expect(kernel.calls).toHaveLength(1);
    const call = kernel.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe(ENGINE_QUOTE_CALCULATE_RPC);
    expect(ENGINE_QUOTE_CALCULATE_RPC).toBe(FIXTURE.rpc);
    const body = call.body as {
      request: unknown;
      actor: unknown;
      datasets: unknown;
    };
    expect(body.request).toEqual(FIXTURE.request);
    expect(body.actor).toEqual({
      id: FIXTURE.actor.id,
      tenant_id: "default",
      team_id: FIXTURE.actor.team_id,
      role: FIXTURE.actor.role,
      account_type: FIXTURE.actor.account_type,
      is_tenant_admin: FIXTURE.actor.is_tenant_admin,
    });
    expect(body.datasets).toEqual(FIXTURE.datasets);
  });

  it("内部 JWT 沿用 mintInternalJwt 口径：HS256/同一 secret/60s + kaas_internal claim", async () => {
    const kernel = kernelSpy();
    await post(envWith(ON, kernel.fetch));

    const bearer = kernel.calls[0]!.authorization.replace(/^Bearer /, "");
    expect(bearer).not.toBe("");
    const { payload } = await jwtVerify(bearer, new TextEncoder().encode(FIXED_SECRET), {
      algorithms: ["HS256"],
    });
    expect(payload.sub).toBe(String(FIXTURE.actor.id));
    expect(payload.kaas_internal).toBe("engine");
    expect(payload.role).toBe(FIXTURE.actor.role);
    expect(payload.account_type).toBe(FIXTURE.actor.account_type);
    expect(payload.team_id).toBe(FIXTURE.actor.team_id);
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(60);
  });

  it("门面按内核信封原样回放 status/body（与 fixture.response 逐字段一致）", async () => {
    const kernel = kernelSpy();
    const res = await post(envWith(ON, kernel.fetch));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FIXTURE.response);
  });

  it("内核业务错误（envelope 4xx）⇒ 原样回放该状态码与 body", async () => {
    const detail = { detail: { error: "engine_error", message: "boom" } };
    const kernel = kernelSpy(
      () => new Response(JSON.stringify({ status: 400, body: detail }), { status: 200 }),
    );
    const res = await post(envWith(ON, kernel.fetch));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(detail);
  });

  it("工位订阅闸门（中间件 404，非信封形状）⇒ 原样回放 404 与 body", async () => {
    // 真实形状来自 ws_workstations.py 的全局中间件（handler 之前返回，故不是 {status,body} 信封）。
    // 2026-10-24 灰度实测：新 RPC 路径未登记 WORKSTATION_PATHS ⇒ 闸门不生效 ⇒ 未开通工位可算价。
    const gate = {
      error: "not_found",
      code: "WORKSTATION_NOT_SUBSCRIBED",
      workstation: "quotes",
      detail: "该工位未开通，请在“工位开通”里启用",
    };
    const kernel = kernelSpy(() => new Response(JSON.stringify(gate), { status: 404 }));
    const res = await post(envWith(ON, kernel.fetch));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(gate);
  });

  it("内核 5xx ⇒ kernel_error（与透传同口径）", async () => {
    const kernel = kernelSpy(() => new Response("kernel exploded", { status: 500 }));
    const res = await post(envWith(ON, kernel.fetch));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("kernel_error");
    expect(body.status).toBe(500);
  });

  it("内核不可达（fetch 抛错）⇒ 502 kernel_unavailable + retryable（与 proxy 同一信封）", async () => {
    const calls: KernelCall[] = [];
    const fetch = vi.fn(async (input: Request | string) => {
      calls.push({ path: "x", method: "POST", authorization: "", body: null });
      throw new Error("NoGilError");
    });
    const res = await post(envWith(ON, fetch as never));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("kernel_unavailable");
    expect(body.retryable).toBe(true);
    expect(body.status).toBe(502);
    // POST + 字符串 body ⇒ 可重放，planKernelRetry 给 2 次机会
    expect(calls).toHaveLength(2);
  }, 10_000);

  it("TS 供数失败（DB 抛错）⇒ 503 db_unavailable（与 kernel_unavailable 分类分开）", async () => {
    resetDb((query: string) => {
      if (query.includes("FROM users WHERE id")) return [userRow()];
      if (query.includes("FROM tenant_products")) throw new Error("connection reset");
      return [];
    });
    const kernel = kernelSpy();
    const res = await post(envWith(ON, kernel.fetch));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("db_unavailable");
    expect(body.retryable).toBe(true);
    expect(kernel.calls).toHaveLength(0);
  });
});

describe("P2 切片 · 开关 off / 白名单未命中：旧路径逐字不变（一键回退）", () => {
  it("AUTH_DB_SPLIT 缺失（默认）⇒ 不取数、原样透传旧端点", async () => {
    const kernel = kernelSpy();
    const res = await post(envWith({}, kernel.fetch));
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM tenant_products")).toHaveLength(0);
    expect(dbCallsContaining("FROM customer_cost_items")).toHaveLength(0);
    expect(kernel.calls).toHaveLength(1);
    expect(kernel.calls[0]!.path).toBe(CALC_PATH);
    expect(kernel.calls[0]!.body).toEqual(FIXTURE.request);
  });

  it("开关 on 但白名单未命中（export-quote.verify）⇒ 仍走旧透传", async () => {
    const kernel = kernelSpy();
    const res = await post(
      envWith({ AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: "export-quote.verify" }, kernel.fetch),
    );
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM tenant_products")).toHaveLength(0);
    expect(kernel.calls[0]!.path).toBe(CALC_PATH);
  });

  it("请求体缺 product_key ⇒ 交给旧路径裁决（不实现第二份校验）", async () => {
    const kernel = kernelSpy();
    const res = await post(envWith(ON, kernel.fetch), { fx_rate: 7.1, orders: [] });
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM tenant_products")).toHaveLength(0);
    expect(kernel.calls[0]!.path).toBe(CALC_PATH);
  });

  it("匿名请求 ⇒ 401，不打到 DB / 内核", async () => {
    const kernel = kernelSpy();
    const res = await post(envWith(ON, kernel.fetch), FIXTURE.request, false);
    expect(res.status).toBe(401);
    expect(dbCallsContaining("FROM tenant_products")).toHaveLength(0);
    expect(kernel.calls).toHaveLength(0);
  });
});
