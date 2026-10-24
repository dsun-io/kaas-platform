/**
 * P2 第三个切片（TS 侧）金标测试：GET /api/v1/trade-docs/{doc_id}/render-data
 * 「门面供数（7 张表）→ 内核纯装配 → 原样回放」。
 *
 * 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6.3 / §9 第 2 项；与 Python 侧
 * backend/worker/tests/test_engine_rpc_trade_docs_render_data.py 读**同一份** fixture：
 * - TS 断言：门面发出的 SQL/参数 == fixture.facade、发给内核的 {request,actor,datasets}
 *   == fixture 对应段、回放 body == fixture.response；
 * - Python 断言：旧路径（自取数）响应/SQL == fixture、新路径（供数）== fixture.response。
 *
 * 与 quotes 同族切片的差异（契约 §6.3 + 本切片 facade 段，改这里必须同步改 Python 侧与文档）：
 * - 条件取数只依赖**数据形状**（customer_id 是否整数、有没有照片引用）；
 *   业务判定（with_seal / company_stamp / product_key_of / 团队可见性）留在内核；
 * - product_profiles 下发整表；tenant_company_seals 恒下发 1 行；
 * - 时间戳列用 to_char 生成 Python isoformat 口径（微秒），不用 JS Date。
 */
import fs from "node:fs";
import path from "node:path";

import { jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import {
  CUSTOMERS_RENDER_SQL,
  CUST_CONTACTS_RENDER_SQL,
  DEFAULT_SEAL_RENDER_SQL,
  ENGINE_ROUTE_IDS,
  ENGINE_TRADE_DOCS_RENDER_DATA_RPC,
  FILE_OBJECTS_RENDER_SQL,
  PRODUCT_PROFILES_RENDER_SQL,
  TENANT_PROFILE_RENDER_SQL,
  TRADE_DOCS_RENDER_SQL,
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
  request: { doc_id: number; request_context: { host: string; x_forwarded_proto: string } };
  asset_time: number;
  actor: {
    id: number;
    account_type: string;
    role: string;
    team_id: number | null;
    is_tenant_admin: boolean;
  };
  datasets: {
    trade_docs: DbRow[];
    tenant_company_profile: DbRow[];
    customers: DbRow[];
    cust_contacts: DbRow[];
    tenant_company_seals: DbRow[];
    product_profiles: DbRow[];
    file_objects: DbRow[];
  };
  old_sql: Array<{ sql: string; params: unknown[] }>;
  facade: Record<string, { sql: string; params: unknown[] }>;
  response: Record<string, unknown>;
}

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname, "..", "..", "ts-migration", "golden",
      "engine-trade-doc-render-data.fixture.json",
    ),
    "utf8",
  ),
) as Fixture;

const RENDER_PATH = FIXTURE.endpoint.path;

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const RENDER_FRAGMENTS = [
  "FROM trade_docs", "FROM tenant_company_profile", "FROM customers",
  "FROM cust_contacts", "FROM file_objects", "FROM tenant_company_seals",
  "FROM product_profiles",
] as const;

/** render-data 的 7 个 dataset 查询（排除鉴权/中间件自身的查询）。 */
function renderDataCalls() {
  return dbState.calls.filter((call) =>
    RENDER_FRAGMENTS.some((fragment) => call.query.includes(fragment)));
}

/** 断言 render-data 的 7 个 dataset 各查了 times 次（旧透传/多给都不允许）。 */
function expectRenderDataQueries(times: number): void {
  for (const fragment of RENDER_FRAGMENTS) {
    expect(dbState.calls.filter((c) => c.query.includes(fragment)), fragment)
      .toHaveLength(times);
  }
}

/** users 行（与 fixture.actor 对齐；requireUser 走 users 查询装载）。 */
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

/**
 * postgres.js 的**原始行形状**：BIGINT/NUMERIC 是字符串（int8/numeric 为了精度），
 * 时间戳是 to_char 出来的文本。门面必须归一成契约口径（fixture.datasets 就是期望）。
 */
function rawTradeDocRow(): DbRow {
  const row = FIXTURE.datasets.trade_docs[0]!;
  return {
    ...row,
    id: String(row.id),
    order_id: row.order_id === null ? null : String(row.order_id),
    customer_id: row.customer_id === null ? null : String(row.customer_id),
    quote_id: row.quote_id === null ? null : String(row.quote_id),
    team_id: row.team_id === null ? null : String(row.team_id),
    total_amount: row.total_amount === null ? null : String(row.total_amount),
  };
}

function rawRows(rows: DbRow[], bigintCols: string[]): DbRow[] {
  return rows.map((row) => {
    const out: DbRow = { ...row };
    for (const col of bigintCols) {
      if (out[col] !== null && out[col] !== undefined) out[col] = String(out[col]);
    }
    return out;
  });
}

/** 按 SQL 片段路由的 DB 桩；返回值模拟 postgres.js 的原始类型。 */
function dbStub(over: (query: string, params: unknown[]) => DbRow[] | null = () => null) {
  return (query: string, params: unknown[]): DbRow[] => {
    const custom = over(query, params);
    if (custom !== null) return custom;
    if (query.includes("FROM users WHERE id")) return [userRow()];
    if (query.includes("FROM trade_docs")) return [rawTradeDocRow()];
    if (query.includes("FROM tenant_company_profile")) {
      return FIXTURE.datasets.tenant_company_profile.map((row) => ({ ...row }));
    }
    if (query.includes("FROM customers")) {
      return rawRows(FIXTURE.datasets.customers, ["id"]);
    }
    if (query.includes("FROM cust_contacts")) {
      return FIXTURE.datasets.cust_contacts.map((row) => ({ ...row }));
    }
    if (query.includes("FROM file_objects")) {
      return rawRows(FIXTURE.datasets.file_objects, ["id", "team_id"]);
    }
    if (query.includes("FROM tenant_company_seals")) {
      return rawRows(FIXTURE.datasets.tenant_company_seals, ["id"]);
    }
    if (query.includes("FROM product_profiles")) {
      return rawRows(FIXTURE.datasets.product_profiles, ["team_id"]);
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

const ON = { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.renderData };

async function call(
  env: ReturnType<typeof makeTestEnv>,
  options: { authorized?: boolean; url?: string } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorized !== false) {
    headers.set(
      "Authorization",
      "Bearer " + (await createToken(FIXTURE.actor.id, FIXED_SECRET)),
    );
  }
  return app.request(options.url ?? "http://testserver" + RENDER_PATH, { method: "GET", headers }, env);
}

beforeEach(() => {
  resetDb(dbStub());
});

describe("P2 render-data · 开关 on：TS 供数（7 张表）→ 内核纯装配 → 原样回放", () => {
  it("门面发出的每条 SQL/参数与供数契约逐字一致（fixture.facade 锁定）", async () => {
    const kernel = kernelSpy();
    const res = await call(envWith(ON, kernel.fetch));
    expect(res.status).toBe(200);

    // 常量与 fixture 同源（防止只比较「实际发生」的调用而常量被单独改掉）
    expect(TRADE_DOCS_RENDER_SQL).toBe(FIXTURE.facade.trade_docs!.sql);
    expect(TENANT_PROFILE_RENDER_SQL).toBe(FIXTURE.facade.tenant_company_profile!.sql);
    expect(CUSTOMERS_RENDER_SQL).toBe(FIXTURE.facade.customers!.sql);
    expect(CUST_CONTACTS_RENDER_SQL).toBe(FIXTURE.facade.cust_contacts!.sql);
    expect(DEFAULT_SEAL_RENDER_SQL).toBe(FIXTURE.facade.tenant_company_seals!.sql);
    expect(PRODUCT_PROFILES_RENDER_SQL).toBe(FIXTURE.facade.product_profiles!.sql);
    expect(FILE_OBJECTS_RENDER_SQL + " AND team_id=$3").toBe(FIXTURE.facade.file_objects!.sql);

    const queryFor = (fragment: string) => dbCallsContaining(fragment);
    const expectCall = (fragment: string, key: string) => {
      const calls = queryFor(fragment).filter((c) => !c.query.includes("FROM users"));
      expect(calls, key).toHaveLength(1);
      expect(norm(calls[0]!.query)).toBe(FIXTURE.facade[key]!.sql);
      expect(calls[0]!.params).toEqual(FIXTURE.facade[key]!.params);
    };
    expectCall("FROM trade_docs", "trade_docs");
    expectCall("FROM tenant_company_profile", "tenant_company_profile");
    expectCall("FROM customers", "customers");
    expectCall("FROM cust_contacts", "cust_contacts");
    expectCall("FROM file_objects", "file_objects");
    expectCall("FROM tenant_company_seals", "tenant_company_seals");
    expectCall("FROM product_profiles", "product_profiles");

    // 7 个 dataset 各一条，一条不多（users/中间件的查询不计）
    expect(renderDataCalls()).toHaveLength(7);
  });

  it("发给内核的 payload 与 fixture 逐字段一致（request/actor/datasets）", async () => {
    const kernel = kernelSpy();
    await call(envWith(ON, kernel.fetch));

    expect(kernel.calls).toHaveLength(1);
    const kernelCall = kernel.calls[0]!;
    expect(kernelCall.method).toBe("POST");
    expect(kernelCall.path).toBe(ENGINE_TRADE_DOCS_RENDER_DATA_RPC);
    expect(ENGINE_TRADE_DOCS_RENDER_DATA_RPC).toBe(FIXTURE.rpc);
    const body = kernelCall.body as {
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
    await call(envWith(ON, kernel.fetch));
    const bearer = kernel.calls[0]!.authorization.replace(/^Bearer /, "");
    expect(bearer).not.toBe("");
    const { payload } = await jwtVerify(bearer, new TextEncoder().encode(FIXED_SECRET), {
      algorithms: ["HS256"],
    });
    expect(payload.sub).toBe(String(FIXTURE.actor.id));
    expect(payload.kaas_internal).toBe("engine");
    expect(payload.role).toBe(FIXTURE.actor.role);
    expect(payload.team_id).toBe(FIXTURE.actor.team_id);
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(60);
  });

  it("门面按内核信封原样回放 status/body（与 fixture.response 逐字段一致）", async () => {
    const kernel = kernelSpy();
    const res = await call(envWith(ON, kernel.fetch));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FIXTURE.response);
  });

  it("工位订阅闸门（内核中间件 404，非信封形状）⇒ 原样回放 404 与 body", async () => {
    const gate = {
      error: "not_found",
      code: "WORKSTATION_NOT_SUBSCRIBED",
      workstation: "trade-docs",
      detail: "该工位未开通，请在“工位开通”里启用",
    };
    const kernel = kernelSpy(() => new Response(JSON.stringify(gate), { status: 404 }));
    const res = await call(envWith(ON, kernel.fetch));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(gate);
  });

  it("内核业务 404（DOC_NOT_FOUND）⇒ 原样回放该状态码与 body", async () => {
    const detail = { detail: { error: "not_found", code: "DOC_NOT_FOUND" } };
    const kernel = kernelSpy(
      () => new Response(JSON.stringify({ status: 404, body: detail }), { status: 200 }),
    );
    const res = await call(envWith(ON, kernel.fetch));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(detail);
  });

  it("内核 5xx ⇒ kernel_error（与透传同口径）", async () => {
    const kernel = kernelSpy(() => new Response("kernel exploded", { status: 500 }));
    const res = await call(envWith(ON, kernel.fetch));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("kernel_error");
  });

  it("TS 供数失败（DB 抛错）⇒ 503 db_unavailable", async () => {
    resetDb(
      dbStub((query: string) =>
        query.includes("FROM trade_docs") ? null : null,
      ),
    );
    resetDb((query: string) => {
      if (query.includes("FROM users WHERE id")) return [userRow()];
      if (query.includes("FROM trade_docs")) throw new Error("connection reset");
      return [];
    });
    const kernel = kernelSpy();
    const res = await call(envWith(ON, kernel.fetch));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("db_unavailable");
    expect(kernel.calls).toHaveLength(0);
  });

  it("AUTH_DB_SPLIT 缺失（默认 off）⇒ 不取数、原样透传旧端点", async () => {
    const kernel = kernelSpy();
    const res = await call(envWith({}, kernel.fetch));
    expect(res.status).toBe(200);
    expectRenderDataQueries(0);
    expect(kernel.calls).toHaveLength(1);
    expect(kernel.calls[0]!.path).toBe(FIXTURE.endpoint.path);
  });

  it("开关 on 但白名单未命中 ⇒ 仍走旧透传（一字不取数）", async () => {
    const kernel = kernelSpy();
    const res = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: "export-quote.calculate" },
      kernel.fetch,
    ));
    expect(res.status).toBe(200);
    expectRenderDataQueries(0);
    expect(kernel.calls[0]!.path).toBe(FIXTURE.endpoint.path);
  });

  it("匿名请求 ⇒ 401，不打到 DB / 内核", async () => {
    const kernel = kernelSpy();
    const res = await call(envWith(ON, kernel.fetch), { authorized: false });
    expect(res.status).toBe(401);
    expect(dbState.calls).toHaveLength(0);
    expect(kernel.calls).toHaveLength(0);
  });

  it("非整数 doc_id ⇒ 交旧路径裁决（不自拼第二份 422）", async () => {
    const kernel = kernelSpy();
    const res = await call(envWith(ON, kernel.fetch), {
      url: "http://testserver/api/v1/trade-docs/abc/render-data",
    });
    expect(res.status).toBe(200);
    expect(kernel.calls).toHaveLength(1);
    expect(kernel.calls[0]!.path).toBe("/api/v1/trade-docs/abc/render-data");
    expectRenderDataQueries(0);
  });
});

describe("P2 render-data · 时间戳口径（docs §8.9：零微秒 ⇒ 无小数）", () => {
  it("门面 SQL 对**每个**时间列都用条件式片段（不能只改一处）", () => {
    // 三列各一个 CASE，且同时包含「无小数」与「6 位小数」两个分支
    expect(TRADE_DOCS_RENDER_SQL.split("CASE WHEN to_char(")).toHaveLength(4);
    for (const col of ["issued_at", "created_at", "updated_at"]) {
      const fragment = tsIsoSql(col);
      expect(TRADE_DOCS_RENDER_SQL).toContain(fragment);
      expect(fragment).toContain("to_char(" + col + " AT TIME ZONE 'UTC', 'US') = '000000'");
      expect(fragment).toContain("'YYYY-MM-DD\"T\"HH24:MI:SS')");
      expect(fragment).toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.US')");
      expect(fragment).toContain("END || '+00:00' AS " + col);
    }
    // 旧的恒 6 位写法不得残留（§8.9 的缺陷形态）
    expect(TRADE_DOCS_RENDER_SQL).not.toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.US\"+00:00\"'");
  });

  it("fixture 覆盖零微秒与非零微秒样本（两侧共享，回放同样是 Python isoformat 口径）", () => {
    const datasetDoc = FIXTURE.datasets.trade_docs[0]!;
    const responseDoc = (FIXTURE.response as { doc: Record<string, unknown> }).doc;
    // 非零微秒 ⇒ 6 位小数；零微秒 ⇒ 无小数
    for (const doc of [datasetDoc, responseDoc]) {
      expect(doc.created_at).toBe("2026-10-20T02:30:00.123456+00:00");
      expect(doc.issued_at).toBe("2026-10-21T08:00:00+00:00");
      expect(doc.updated_at).toBe("2026-10-24T03:04:05+00:00");
      expect(String(doc.created_at)).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
      expect(String(doc.issued_at)).toMatch(/T\d{2}:\d{2}:\d{2}\+00:00$/);
      expect(String(doc.updated_at)).toMatch(/T\d{2}:\d{2}:\d{2}\+00:00$/);
    }
  });
});

describe("P2 render-data · 供数决策（条件取数只依赖数据形状）", () => {
  it("管理员 ⇒ 文件行不加团队谓词（与 ws_files._team_scope 同一把尺）", async () => {
    resetDb((query: string) => {
      if (query.includes("FROM users WHERE id")) {
        return [userRow({ role: "system_admin", account_type: "internal" })];
      }
      return dbStub()(query, []);
    });
    const kernel = kernelSpy();
    const res = await call(envWith(ON, kernel.fetch));
    expect(res.status).toBe(200);
    const fileCalls = dbCallsContaining("FROM file_objects");
    expect(fileCalls).toHaveLength(1);
    expect(norm(fileCalls[0]!.query)).toBe(FILE_OBJECTS_RENDER_SQL);
    expect(fileCalls[0]!.params).toEqual(["default", [12, 13]]);
    // 管理员 JWT 快照里 role = system_admin
    const body = kernel.calls[0]!.body as { actor: { role: string } };
    expect(body.actor.role).toBe("system_admin");
  });

  it("无团队客户 ⇒ 不下发文件行（不能在这里抛 403：render-data 的闸门是内核 404）", async () => {
    resetDb((query: string) => {
      if (query.includes("FROM users WHERE id")) return [userRow({ team_id: null })];
      return dbStub()(query, []);
    });
    const kernel = kernelSpy();
    const res = await call(envWith(ON, kernel.fetch));
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM file_objects")).toHaveLength(0);
    const body = kernel.calls[0]!.body as { datasets: { file_objects: unknown[] } };
    expect(body.datasets.file_objects).toEqual([]);
  });

  it("单据没有照片引用 ⇒ 不查 file_objects", async () => {
    resetDb((query: string) => {
      if (query.includes("FROM users WHERE id")) return [userRow()];
      if (query.includes("FROM trade_docs")) {
        const row = rawTradeDocRow();
        const payload = row.raw_payload as { custom: Record<string, unknown> };
        return [{ ...row, raw_payload: { ...payload, custom: { ...payload.custom, product_photos: [] } } }];
      }
      return dbStub()(query, []);
    });
    const kernel = kernelSpy();
    const res = await call(envWith(ON, kernel.fetch));
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM file_objects")).toHaveLength(0);
    const body = kernel.calls[0]!.body as { datasets: { file_objects: unknown[] } };
    expect(body.datasets.file_objects).toEqual([]);
  });

  it("请求带 x-forwarded-proto ⇒ request_context 用它（签名 URL 的协议）", async () => {
    const kernel = kernelSpy();
    const headers = new Headers({
      "content-type": "application/json",
      "x-forwarded-proto": "https",
      host: "kaas.powervoy.com",
    });
    headers.set("Authorization", "Bearer " + (await createToken(FIXTURE.actor.id, FIXED_SECRET)));
    await app.request(RENDER_PATH, { method: "GET", headers }, envWith(ON, kernel.fetch));
    const body = kernel.calls[0]!.body as {
      request: { request_context: { host: string; x_forwarded_proto: string } };
    };
    expect(body.request.request_context).toEqual({
      host: "kaas.powervoy.com",
      x_forwarded_proto: "https",
    });
  });
});

describe("P2 render-data · 路由面", () => {
  it("GET render-data 恰好注册一次（改实现不改路由面）", () => {
    const routes = (app.routes as Array<{ method: string; path: string }>).map(
      (r) => r.method.toUpperCase() + " " + r.path,
    );
    expect(
      routes.filter((r) => r === "GET /api/v1/trade-docs/:doc_id/render-data"),
    ).toHaveLength(1);
  });

  it("路由 id 命名口径与 quotes 同族一致（<域>.<端点>）", () => {
    expect(ENGINE_ROUTE_IDS.renderData).toBe("trade-docs.render-data");
    expect(ENGINE_TRADE_DOCS_RENDER_DATA_RPC).toBe(
      "/api/v1/internal/engine/trade-docs/render-data",
    );
  });
});
