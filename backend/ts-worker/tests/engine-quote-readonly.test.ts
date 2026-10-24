/**
 * P2 同族只读切片（TS 侧）金标测试：门面「供数 → 内核纯算 → 原样回放」。
 *
 * 覆盖 verify / formulas / spec 三条（calculate 见 engine-quote-calculate.test.ts）：
 * 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8/§9#1；与 Python 侧
 * backend/worker/tests/test_engine_rpc_quote_readonly.py 读**同一份** fixture：
 * - TS 断言：门面发出的 SQL == fixture.sql、绑定参数 == fixture.sql_params、
 *   发给内核的 {request,actor,datasets} == fixture 对应段、回放 body == fixture.response；
 * - Python 断言：旧路径（自取数）== 新路径（供数）== fixture.response。
 * ⇒ 任一侧供数/契约漂移都会让 CI 变红（fixture 禁止在测试里自更新）。
 *
 * 闸门（否则不放量）：
 * - 工位订阅：内核中间件 404 必须原样回放（§8.5.2 灰度踩坑）；
 * - 角色：verify 的 403 由**内核**用内部令牌的角色快照判定（门面不做第二份判定），
 *   原样回放 403 与旧路径逐字一致；
 * - 回退：开关 off / 白名单未命中 ⇒ 一字不取数，原样透传。
 */
import fs from "node:fs";
import path from "node:path";

import { jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import {
  CUSTOMER_COST_ITEMS_SQL,
  ENGINE_QUOTE_CALCULATE_RPC,
  ENGINE_QUOTE_EXPLAIN_RPC,
  ENGINE_QUOTE_FORMULAS_RPC,
  ENGINE_QUOTE_SPEC_RPC,
  ENGINE_QUOTE_VERIFY_RPC,
  ENGINE_ROUTE_IDS,
  TENANT_PRODUCTS_SQL,
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
    team_id: number;
    is_tenant_admin: boolean;
  };
  datasets: { tenant_products: DbRow[]; customer_cost_items: DbRow[] };
  sql: { tenant_products: string; customer_cost_items: string };
  sql_params: { tenant_products: unknown[]; customer_cost_items: unknown[] };
  response: Record<string, unknown>;
}

function loadFixture(name: string): Fixture {
  const file = path.join(
    __dirname, "..", "..", "ts-migration", "golden", "engine-quote-" + name + ".fixture.json",
  );
  return JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
}

const FIXTURES: Record<string, Fixture> = {
  verify: loadFixture("verify"),
  formulas: loadFixture("formulas"),
  spec: loadFixture("spec"),
  explain: loadFixture("explain"),
};

const SLICES = ["verify", "formulas", "spec", "explain"] as const;
type SliceName = (typeof SLICES)[number];

/** 用户行（与 fixture.actor 对齐；requireUser 走 users 查询装载）。 */
function userRow(actor: Fixture["actor"], over: Partial<DbRow> = {}): DbRow {
  return {
    id: actor.id,
    email: "buyer@qa.test",
    display_name: "买家",
    account_type: actor.account_type,
    role: actor.role,
    status: "active",
    team_id: actor.team_id,
    console_access: false,
    plan: "free",
    is_tenant_admin: actor.is_tenant_admin,
    ...over,
  };
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** 按 SQL 片段路由的 DB 桩；users 查询按当前切片 actor 返回。 */
function dbStubFor(name: SliceName, over: (query: string) => DbRow[] | null = () => null) {
  return (query: string): DbRow[] => {
    const custom = over(query);
    if (custom !== null) return custom;
    if (query.includes("FROM users WHERE id")) return [userRow(FIXTURES[name]!.actor)];
    if (query.includes("FROM tenant_products")) return FIXTURES[name]!.datasets.tenant_products;
    if (query.includes("FROM customer_cost_items")) {
      return FIXTURES[name]!.datasets.customer_cost_items;
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
  respond: (call: KernelCall) => Response = (call) => {
    // 默认：RPC 调用回该切片的 fixture.response；旧端点透传（开关 off 路径）
    // 回一个 200 空体 —— 那条分支只断言「路径/请求体/不取数」，不比较业务响应。
    const name = SLICES.find((s) => FIXTURES[s]!.rpc === call.path);
    const body = name ? FIXTURES[name]!.response : { ok: true };
    return new Response(JSON.stringify({ status: 200, body }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
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

function onFlags(...ids: string[]): Record<string, unknown> {
  return { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ids.join(",") };
}

/** 旧端点 URL（fixture.endpoint.path [+ ?query]）。 */
function endpointUrl(name: SliceName): string {
  const endpoint = FIXTURES[name]!.endpoint;
  return endpoint.query_string ? endpoint.path + "?" + endpoint.query_string : endpoint.path;
}

async function call(
  name: SliceName,
  env: ReturnType<typeof makeTestEnv>,
  options: { body?: unknown; authorized?: boolean; url?: string } = {},
): Promise<Response> {
  const fixture = FIXTURES[name]!;
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorized !== false) {
    headers.set(
      "Authorization",
      "Bearer " + (await createToken(fixture.actor.id, FIXED_SECRET)),
    );
  }
  const url = options.url ?? endpointUrl(name);
  const init: RequestInit = { method: fixture.endpoint.method, headers };
  if (fixture.endpoint.method === "POST") {
    // explain 的 product_key 在路径上，旧端点正文 = request.body（其余 POST 切片正文 = request）
    const oldBody = name === "explain" ? (fixture.request as { body: unknown }).body : fixture.request;
    init.body = JSON.stringify(options.body ?? oldBody);
  }
  return app.request(url, init, env);
}

beforeEach(() => {
  resetDb(dbStubFor("verify"));
});

describe("P2 同族只读切片 · 开关 on：TS 供数 → 内核纯算 → 原样回放", () => {
  for (const name of SLICES) {
    describe(name, () => {
      beforeEach(() => {
        resetDb(dbStubFor(name));
      });

      it("门面发出的 SQL/参数与 Python 旧路径逐字一致（fixture 锁）", async () => {
        const fixture = FIXTURES[name]!;
        const kernel = kernelSpy();
        const res = await call(name, envWith(onFlags(ENGINE_ROUTE_IDS[name]), kernel.fetch));
        expect(res.status).toBe(200);

        const tenantCalls = dbCallsContaining("FROM tenant_products");
        expect(tenantCalls).toHaveLength(1);
        expect(norm(tenantCalls[0]!.query)).toBe(fixture.sql.tenant_products);
        expect(tenantCalls[0]!.params).toEqual(fixture.sql_params.tenant_products);
        // SQL 常量与 fixture 同源（防止常量被单独改掉而测试只比较「实际发生」的调用）
        expect(TENANT_PRODUCTS_SQL).toBe(fixture.sql.tenant_products);
        // 该端点旧路径是否查客户定价数据以 fixture 为准（explain 不查）
        const costCalls = dbCallsContaining("FROM customer_cost_items");
        if (fixture.sql.customer_cost_items) {
          expect(costCalls).toHaveLength(1);
          expect(norm(costCalls[0]!.query)).toBe(fixture.sql.customer_cost_items);
          expect(costCalls[0]!.params).toEqual(fixture.sql_params.customer_cost_items);
          expect(CUSTOMER_COST_ITEMS_SQL).toBe(fixture.sql.customer_cost_items);
        } else {
          expect(costCalls).toHaveLength(0);
        }
      });

      it("发给内核的 payload 与 fixture 逐字段一致（request/actor/datasets）", async () => {
        const fixture = FIXTURES[name]!;
        const kernel = kernelSpy();
        await call(name, envWith(onFlags(ENGINE_ROUTE_IDS[name]), kernel.fetch));

        expect(kernel.calls).toHaveLength(1);
        const kernelCall = kernel.calls[0]!;
        expect(kernelCall.method).toBe("POST");
        expect(kernelCall.path).toBe(fixture.rpc);
        const body = kernelCall.body as {
          request: unknown;
          actor: unknown;
          datasets: unknown;
        };
        expect(body.request).toEqual(fixture.request);
        expect(body.actor).toEqual({
          id: fixture.actor.id,
          tenant_id: "default",
          team_id: fixture.actor.team_id,
          role: fixture.actor.role,
          account_type: fixture.actor.account_type,
          is_tenant_admin: fixture.actor.is_tenant_admin,
        });
        expect(body.datasets).toEqual(fixture.datasets);
      });

      it("内部 JWT 沿用 mintInternalJwt 口径：HS256/同一 secret/60s + kaas_internal claim", async () => {
        const fixture = FIXTURES[name]!;
        const kernel = kernelSpy();
        await call(name, envWith(onFlags(ENGINE_ROUTE_IDS[name]), kernel.fetch));

        const bearer = kernel.calls[0]!.authorization.replace(/^Bearer /, "");
        expect(bearer).not.toBe("");
        const { payload } = await jwtVerify(bearer, new TextEncoder().encode(FIXED_SECRET), {
          algorithms: ["HS256"],
        });
        expect(payload.sub).toBe(String(fixture.actor.id));
        expect(payload.kaas_internal).toBe("engine");
        expect(payload.role).toBe(fixture.actor.role);
        expect(payload.account_type).toBe(fixture.actor.account_type);
        expect(payload.is_tenant_admin).toBe(fixture.actor.is_tenant_admin);
        expect(payload.team_id).toBe(fixture.actor.team_id);
        expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(60);
      });

      it("门面按内核信封原样回放 status/body（与 fixture.response 逐字段一致）", async () => {
        const fixture = FIXTURES[name]!;
        const kernel = kernelSpy();
        const res = await call(name, envWith(onFlags(ENGINE_ROUTE_IDS[name]), kernel.fetch));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(fixture.response);
      });

      it("工位订阅闸门（内核中间件 404，非信封形状）⇒ 原样回放 404 与 body", async () => {
        const gate = {
          error: "not_found",
          code: "WORKSTATION_NOT_SUBSCRIBED",
          workstation: "quotes",
          detail: "该工位未开通，请在“工位开通”里启用",
        };
        const kernel = kernelSpy(
          () => new Response(JSON.stringify(gate), { status: 404 }),
        );
        const res = await call(name, envWith(onFlags(ENGINE_ROUTE_IDS[name]), kernel.fetch));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(gate);
      });

      it("开关 on 但白名单未命中 ⇒ 仍走旧透传（一字不取数）", async () => {
        const kernel = kernelSpy();
        const res = await call(
          name,
          envWith(onFlags("export-quote.calculate"), kernel.fetch),
        );
        expect(res.status).toBe(200);
        expect(dbCallsContaining("FROM tenant_products")).toHaveLength(0);
        expect(dbCallsContaining("FROM customer_cost_items")).toHaveLength(0);
        expect(kernel.calls[0]!.path).toBe(FIXTURES[name]!.endpoint.path);
      });

      it("AUTH_DB_SPLIT 缺失（默认 off）⇒ 不取数、原样透传旧端点", async () => {
        const kernel = kernelSpy();
        const res = await call(name, envWith({}, kernel.fetch));
        expect(res.status).toBe(200);
        expect(dbCallsContaining("FROM tenant_products")).toHaveLength(0);
        expect(dbCallsContaining("FROM customer_cost_items")).toHaveLength(0);
        expect(kernel.calls).toHaveLength(1);
        expect(kernel.calls[0]!.path).toBe(FIXTURES[name]!.endpoint.path);
      });

      it("匿名请求 ⇒ 401，不打到 DB / 内核", async () => {
        const kernel = kernelSpy();
        const res = await call(name, envWith(onFlags(ENGINE_ROUTE_IDS[name]), kernel.fetch), {
          authorized: false,
        });
        expect(res.status).toBe(401);
        expect(dbCallsContaining("FROM tenant_products")).toHaveLength(0);
        expect(kernel.calls).toHaveLength(0);
      });

      it("内核业务错误（envelope 4xx）⇒ 原样回放该状态码与 body", async () => {
        const detail = { detail: { error: "engine_error", message: "boom" } };
        const kernel = kernelSpy(
          () => new Response(JSON.stringify({ status: 400, body: detail }), { status: 200 }),
        );
        const res = await call(name, envWith(onFlags(ENGINE_ROUTE_IDS[name]), kernel.fetch));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(detail);
      });

      it("内核 5xx ⇒ kernel_error（与透传同口径）", async () => {
        const kernel = kernelSpy(() => new Response("kernel exploded", { status: 500 }));
        const res = await call(name, envWith(onFlags(ENGINE_ROUTE_IDS[name]), kernel.fetch));
        expect(res.status).toBe(500);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe("kernel_error");
        expect(body.status).toBe(500);
      });

      it("TS 供数失败（DB 抛错）⇒ 503 db_unavailable（与 kernel_unavailable 分类分开）", async () => {
        resetDb(
          dbStubFor(name, (query: string) => {
            if (query.includes("FROM tenant_products")) throw new Error("connection reset");
            return null;
          }),
        );
        const kernel = kernelSpy();
        const res = await call(name, envWith(onFlags(ENGINE_ROUTE_IDS[name]), kernel.fetch));
        expect(res.status).toBe(503);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe("db_unavailable");
        expect(body.retryable).toBe(true);
        expect(kernel.calls).toHaveLength(0);
      });
    });
  }
});

describe("P2 同族只读切片 · 角色闸门（verify = 内部管理员，判定在内核）", () => {
  it("内核 403（同一份 _require_internal_admin）⇒ 原样回放 403 与逐字 body", async () => {
    const forbidden = {
      detail: { error: "forbidden", message: "内部核算视图需要租户管理员权限" },
    };
    const kernel = kernelSpy(
      () => new Response(JSON.stringify({ status: 403, body: forbidden }), { status: 200 }),
    );
    const res = await call("verify", envWith(onFlags(ENGINE_ROUTE_IDS.verify), kernel.fetch));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(forbidden);
  });

  it("门面不自行判定管理员：非管理员也会把供数与 datasets 交给内核裁决", async () => {
    const fixture = FIXTURES.verify!;
    resetDb((query: string) => {
      if (query.includes("FROM users WHERE id")) {
        return [userRow(fixture.actor, { role: "owner", account_type: "customer" })];
      }
      return dbStubFor("verify")(query);
    });
    const kernel = kernelSpy();
    const res = await call("verify", envWith(onFlags(ENGINE_ROUTE_IDS.verify), kernel.fetch));
    expect(res.status).toBe(200);
    expect(kernel.calls).toHaveLength(1);
    const body = kernel.calls[0]!.body as { actor: { role: string } };
    expect(body.actor.role).toBe("owner");
  });
});

describe("P2 同族只读切片 · formulas 的供数决策（query 参数）", () => {
  beforeEach(() => {
    resetDb(dbStubFor("formulas"));
  });

  it("with_customer_options=false ⇒ 不查客户定价数据（与旧 handler 同）", async () => {
    const kernel = kernelSpy();
    const res = await call("formulas", envWith(onFlags(ENGINE_ROUTE_IDS.formulas), kernel.fetch), {
      url: FIXTURES.formulas!.endpoint.path
        + "?with_columns=true&with_customer_options=false",
    });
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM customer_cost_items")).toHaveLength(0);
    const body = kernel.calls[0]!.body as { request: { query: Record<string, unknown> } };
    // query 原始字符串原样透传给内核（解析/校验在内核同一份 pydantic 口径）
    expect(body.request.query).toEqual({
      with_columns: "true",
      with_customer_options: "false",
      customer_id: null,
    });
  });

  it("customer_id 只对管理员生效（普通账号强制回落到自己的客户）", async () => {
    const kernel = kernelSpy();
    await call("formulas", envWith(onFlags(ENGINE_ROUTE_IDS.formulas), kernel.fetch), {
      url: FIXTURES.formulas!.endpoint.path + "?customer_id=other_customer",
    });
    const costCalls = dbCallsContaining("FROM customer_cost_items");
    expect(costCalls).toHaveLength(1);
    expect(costCalls[0]!.params).toEqual(["default", "field_fence:", "default"]);
  });

  it("管理员传 customer_id ⇒ 定价数据按该客户过滤（与旧路径 _can_see_all 同一把尺）", async () => {
    resetDb((query: string) => {
      if (query.includes("FROM users WHERE id")) {
        return [userRow(FIXTURES.verify!.actor)]; // internal + system_admin
      }
      return dbStubFor("formulas")(query);
    });
    const kernel = kernelSpy();
    const res = await call("formulas", envWith(onFlags(ENGINE_ROUTE_IDS.formulas), kernel.fetch), {
      url: FIXTURES.formulas!.endpoint.path + "?customer_id=other_customer",
    });
    expect(res.status).toBe(200);
    const costCalls = dbCallsContaining("FROM customer_cost_items");
    expect(costCalls).toHaveLength(1);
    expect(costCalls[0]!.params).toEqual(["default", "field_fence:", "other_customer"]);
  });

  it("非法布尔值不在门面报错（交给内核同一份 pydantic 报 422）", async () => {
    const kernel = kernelSpy(
      () =>
        new Response(
          JSON.stringify({
            status: 422,
            body: {
              detail: [
                {
                  type: "bool_parsing",
                  loc: ["query", "with_columns"],
                  msg: "Input should be a valid boolean, unable to interpret input",
                  input: "xyz",
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const res = await call("formulas", envWith(onFlags(ENGINE_ROUTE_IDS.formulas), kernel.fetch), {
      url: FIXTURES.formulas!.endpoint.path + "?with_columns=xyz",
    });
    expect(res.status).toBe(422);
    expect(kernel.calls).toHaveLength(1);
  });
});

describe("P2 同族只读切片 · explain 的供数决策（草稿分支不读库）", () => {
  beforeEach(() => {
    resetDb(dbStubFor("explain"));
  });

  it("spec_override（草稿试算）⇒ 完全不读库，datasets 为空", async () => {
    const kernel = kernelSpy();
    const draft = {
      spec: { height_m: 1.5 },
      spec_override: {
        name: "草稿产品",
        numeric_inputs: [{ key: "height_m", label: "网高(m)", default: 1.2 }],
        derived: [{ name: "height_mm", expr: "height_m * 1000", unit: "mm" }],
      },
    };
    const res = await call(
      "explain",
      envWith(onFlags(ENGINE_ROUTE_IDS.explain), kernel.fetch),
      { body: draft },
    );
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM tenant_products")).toHaveLength(0);
    expect(dbCallsContaining("FROM customer_cost_items")).toHaveLength(0);
    const body = kernel.calls[0]!.body as {
      request: { product_key: string; body: unknown };
      datasets: unknown;
    };
    expect(body.request.body).toEqual(draft);
    expect(body.datasets).toEqual({ tenant_products: [], customer_cost_items: [] });
  });

  it("非草稿 explain 只供 tenant_products（不查客户定价数据）", async () => {
    const kernel = kernelSpy();
    await call("explain", envWith(onFlags(ENGINE_ROUTE_IDS.explain), kernel.fetch));
    expect(dbCallsContaining("FROM tenant_products")).toHaveLength(1);
    expect(dbCallsContaining("FROM customer_cost_items")).toHaveLength(0);
    const body = kernel.calls[0]!.body as {
      request: { product_key: string };
      datasets: { customer_cost_items: unknown[] };
    };
    expect(body.request.product_key).toBe("field_fence");
    expect(body.datasets.customer_cost_items).toEqual([]);
  });
});

describe("P2 同族只读切片 · 路由面（改实现不改路由面）", () => {
  it("五条 RPC 路径互相独立（不会把 calculate 的路径复用给别的 action）", () => {
    expect(new Set([
      ENGINE_QUOTE_CALCULATE_RPC,
      ENGINE_QUOTE_VERIFY_RPC,
      ENGINE_QUOTE_FORMULAS_RPC,
      ENGINE_QUOTE_SPEC_RPC,
      ENGINE_QUOTE_EXPLAIN_RPC,
    ]).size).toBe(5);
    expect(ENGINE_QUOTE_CALCULATE_RPC).toBe(FIXTURES.verify!.rpc.replace(/\/verify$/, "/calculate"));
    expect(ENGINE_QUOTE_VERIFY_RPC).toBe(FIXTURES.verify!.rpc);
    expect(ENGINE_QUOTE_FORMULAS_RPC).toBe(FIXTURES.formulas!.rpc);
    expect(ENGINE_QUOTE_SPEC_RPC).toBe(FIXTURES.spec!.rpc);
    expect(ENGINE_QUOTE_EXPLAIN_RPC).toBe(FIXTURES.explain!.rpc);
  });

  it("四条新切片路由各恰好注册一次（改实现不改路由面，重复注册会让 Hono 先注册者吞后者）", () => {
    const routes = (app.routes as Array<{ method: string; path: string }>).map(
      (r) => r.method.toUpperCase() + " " + r.path,
    );
    const expected = [
      "POST /api/v1/export-quote/verify",
      "GET /api/v1/export-quote/products/:product_key/formulas",
      "GET /api/v1/export-quote/products/:product_key/spec",
      "POST /api/v1/export-quote/products/:product_key/explain",
    ];
    for (const route of expected) {
      expect(routes.filter((r) => r === route), route).toHaveLength(1);
    }
  });

  it("路由 id 与 AUTH_DB_SPLIT_ROUTES 的命名口径一致", () => {
    expect(ENGINE_ROUTE_IDS.verify).toBe("export-quote.verify");
    expect(ENGINE_ROUTE_IDS.formulas).toBe("export-quote.formulas");
    expect(ENGINE_ROUTE_IDS.spec).toBe("export-quote.spec");
    expect(ENGINE_ROUTE_IDS.explain).toBe("export-quote.explain");
  });
});
