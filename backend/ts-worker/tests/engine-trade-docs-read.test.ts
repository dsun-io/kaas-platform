/**
 * P3 第五批切片金标（TS 侧）：GET /api/v1/trade-docs（列表）+ /trade-docs/{doc_id}（详情）
 * 「门面供数 → 内核纯投影 → 原样回放」。
 *
 * 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8；与 Python 侧
 * backend/worker/tests/test_engine_rpc_trade_docs_read.py 读**同一份** fixture。
 *
 * 本切片要点：
 * - trade_docs 显式列（BIGINT/NUMERIC 归一；时间戳 tsIsoSql 条件式）；
 * - 列表 = COUNT + 当前页 + **逐行「链路更晚单证」检查**（quote_id 优先、否则 order_id）+
 *   对账结论 ANY 批量；
 * - 列表作用域谓词下推（非管理员；无团队时旧路径 403 ⇒ 门面不查库、空供数）；
 * - 详情 SQL **无**作用域谓词（可见性由内核行级判定），links/later 只在有行时才查。
 */
import fs from "node:fs";
import path from "node:path";

import { jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import {
  ENGINE_ROUTE_IDS,
  ENGINE_TRADE_DOCS_DETAIL_RPC,
  ENGINE_TRADE_DOCS_LIST_RPC,
  TRADE_DOC_CHECKS_SQL,
  TRADE_DOC_COLUMNS,
  TRADE_DOC_LATER_ORDER_SQL,
  TRADE_DOC_LATER_QUOTE_SQL,
  TRADE_DOC_LINKS_SQL,
  tradeDocDatasetRow,
  tradeDocsCountSql,
  tradeDocsDetailSql,
  tradeDocsListSql,
  tsIsoSql,
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
    __dirname, "..", "..", "ts-migration", "golden", "engine-trade-docs-" + name + ".fixture.json",
  );
  return JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
}

const LIST = loadFixture("list");
const DETAIL = loadFixture("detail");

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

const BIGINT_COLS = ["id", "order_id", "customer_id", "quote_id", "team_id"];

/** postgres.js 原始行形状：int8 是字符串、numeric 是字符串、timestamptz 已由 SQL 转文本。 */
function rawDocRow(row: DbRow): DbRow {
  const out: DbRow = { ...row };
  for (const col of BIGINT_COLS) {
    if (out[col] !== null && out[col] !== undefined) out[col] = String(out[col]);
  }
  if (out.total_amount !== null && out.total_amount !== undefined) {
    out.total_amount = String(out.total_amount);
  }
  return out;
}

/** 按 SQL 片段路由的 DB 桩（列表 / 详情两套返回；模拟 postgres.js 原始类型）。 */
function dbStub(fixture: Fixture, over: (query: string) => DbRow[] | null = () => null) {
  return (query: string, params: unknown[]): DbRow[] => {
    const custom = over(query);
    if (custom !== null) return custom;
    if (query.includes("FROM users WHERE id")) return [userRow(fixture)];
    if (query.includes("FROM trade_doc_render_checks")) {
      return (fixture.datasets.render_checks ?? []).map((row) => ({
        trade_doc_id: String(row.trade_doc_id),
        matches: Boolean(row.matches),
        reason: row.reason,
        render_version_drift: Boolean(row.render_version_drift),
        checked_at: row.checked_at,
      }));
    }
    if (query.includes("FROM entity_links")) {
      return (fixture.datasets.entity_links ?? []).map((row) => ({
        dst_type: row.dst_type,
        dst_id: String(row.dst_id),
        rel_type: row.rel_type,
        meta: row.meta ?? null,
      }));
    }
    if (query.includes("FROM trade_docs")) {
      if (query.includes("COUNT(*)")) {
        return (fixture.datasets.trade_docs_total ?? []).map((row) => ({
          count: String(row.count),
        }));
      }
      if (query.includes("AND id>$3")) {
        const laterRows = fixture.datasets.later_docs ?? [];
        if (laterRows.some((row) => row.doc_id !== undefined)) {
          // 列表：逐行检查，dataset 行是 {doc_id}（命中才有行）
          const wanted = Number(params[2]);
          return laterRows.some((row) => Number(row.doc_id) === wanted) ? [{ one: 1 }] : [];
        }
        // 详情：SELECT 1 … LIMIT 1，dataset 行是 {locked:1}（非空即命中）
        return laterRows.length > 0 ? [{ one: 1 }] : [];
      }
      if (query.includes("WHERE tenant_id = $1 AND id = $2")) {
        return (fixture.datasets.trade_docs ?? []).map(rawDocRow);
      }
      return (fixture.datasets.trade_docs ?? []).map(rawDocRow);
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

const ON_LIST = { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.tradeDocsList };
const ON_DETAIL = { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.tradeDocsDetail };

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

describe("P3 trade-docs 列表 · 开关 on：TS 供数 → 内核纯投影 → 原样回放", () => {
  beforeEach(() => {
    resetDb(dbStub(LIST));
  });

  it("门面发出的每条 SQL/参数与供数契约逐字一致（fixture.facade 锁定）", async () => {
    const kernel = kernelSpy();
    const res = await callList(envWith(ON_LIST, kernel.fetch));
    expect(res.status).toBe(200);

    expect(TRADE_DOC_COLUMNS).toBe(LIST.facade.trade_docs!.columns);
    const countCall = dbCallsContaining("COUNT(*)")[0]!;
    expect(norm(countCall.query)).toBe(LIST.facade.trade_docs_total!.sql);
    expect(countCall.params).toEqual(LIST.facade.trade_docs_total!.params);
    const rowsCall = dbCallsContaining("FROM trade_docs")
      .find((c) => c.query.includes("ORDER BY created_at DESC"))!;
    expect(norm(rowsCall.query)).toBe(LIST.facade.trade_docs!.sql);
    expect(rowsCall.params).toEqual(LIST.facade.trade_docs!.params);
    const laterCalls = dbCallsContaining("AND id>$3");
    expect(laterCalls).toHaveLength(2);   // 两行 ⇒ 两次逐行检查（同旧路径）
    expect(norm(laterCalls[0]!.query)).toBe(LIST.facade.later_docs!.sql);
    expect(laterCalls[0]!.params).toEqual(LIST.facade.later_docs!.params);
    const checksCall = dbCallsContaining("FROM trade_doc_render_checks")[0]!;
    expect(norm(checksCall.query)).toBe(LIST.facade.render_checks!.sql);
    expect(checksCall.params).toEqual(LIST.facade.render_checks!.params);

    // 构造器与常量同源
    const cond = LIST.facade.trade_docs!.sql!.split(" WHERE ")[1]!.split(" ORDER BY ")[0]!;
    expect(tradeDocsCountSql(cond)).toBe(LIST.facade.trade_docs_total!.sql);
    expect(tradeDocsListSql(cond, LIST.facade.trade_docs_total!.params!.length))
      .toBe(LIST.facade.trade_docs!.sql);
    expect(TRADE_DOC_LATER_ORDER_SQL).toBe(LIST.facade.later_docs!.sql);
    expect(TRADE_DOC_CHECKS_SQL).toBe(LIST.facade.render_checks!.sql);
  });

  it("发给内核的 payload 与 fixture 逐字段一致（request/actor/datasets）", async () => {
    const kernel = kernelSpy();
    await callList(envWith(ON_LIST, kernel.fetch));
    expect(kernel.calls).toHaveLength(1);
    const call = kernel.calls[0]!;
    expect(call.path).toBe(ENGINE_TRADE_DOCS_LIST_RPC);
    expect(ENGINE_TRADE_DOCS_LIST_RPC).toBe(LIST.rpc);
    const body = call.body as { request: unknown; actor: unknown; datasets: unknown };
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

  it("内部 JWT 沿用 mintEngineJwt 口径（HS256 / 同一 secret / 60s / kaas_internal）", async () => {
    const kernel = kernelSpy();
    await callList(envWith(ON_LIST, kernel.fetch));
    const bearer = kernel.calls[0]!.authorization.replace(/^Bearer /, "");
    const { payload } = await jwtVerify(bearer, new TextEncoder().encode(FIXED_SECRET), {
      algorithms: ["HS256"],
    });
    expect(payload.kaas_internal).toBe("engine");
    expect(payload.sub).toBe(String(LIST.actor.id));
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(60);
  });

  it("回放 body == fixture.response（逐字段）", async () => {
    const res = await callList(envWith(ON_LIST, kernelSpy().fetch));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIST.response);
  });

  it("时间戳条件式：零微秒无小数 / 非零 6 位；旧的恒 6 位写法零残留", () => {
    const columns = LIST.facade.trade_docs!.columns!;
    expect(columns.split("CASE WHEN to_char(")).toHaveLength(4);   // 3 列 + split 尾
    for (const col of ["issued_at", "created_at", "updated_at"]) {
      expect(columns).toContain(tsIsoSql(col));
    }
    expect(columns).not.toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.US\"+00:00\"'");
    const items = LIST.response.items as Array<Record<string, unknown>>;
    expect(String(items[0]!.issued_at)).toMatch(/T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(String(items[0]!.created_at)).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
  });

  it("非管理员：列表作用域谓词下推（team/owner/tenant 三条，与 _doc_scope_sql 同义）", async () => {
    await callList(envWith(ON_LIST, kernelSpy().fetch));
    const sql = LIST.facade.trade_docs!.sql!;
    expect(sql).toContain("(team_id = $4 OR owner_id = $5 OR owner_scope = 'tenant')");
    expect(LIST.facade.trade_docs!.params!.slice(0, -2)).toEqual([
      "default", "packing_list", "issued", 2, "5",
    ]);
    expect(LIST.facade.trade_docs!.params!.slice(-2)).toEqual([20, 0]);
  });

  it("管理员 / internal：不加作用域谓词", async () => {
    resetDb(dbStub(LIST, (query) =>
      query.includes("FROM users WHERE id")
        ? [userRow(LIST, { role: "system_admin", account_type: "internal" })]
        : null));
    await callList(envWith(ON_LIST, kernelSpy().fetch));
    const rowsCall = dbCallsContaining("FROM trade_docs")
      .find((c) => c.query.includes("ORDER BY created_at DESC"))!;
    expect(norm(rowsCall.query)).not.toContain("team_id = $");
    expect(rowsCall.params).toEqual(["default", "packing_list", "issued", 20, 0]);
  });

  it("无团队客户：不查库、空供数（403 判决在内核同一份判定）", async () => {
    resetDb(dbStub(LIST, (query) =>
      query.includes("FROM users WHERE id") ? [userRow(LIST, { team_id: null })] : null));
    const kernel = kernelSpy(() => new Response(
      JSON.stringify({ status: 403, body: { detail: { error: "forbidden", code: "NO_TEAM" } } }),
      { status: 200 },
    ));
    const res = await callList(envWith(ON_LIST, kernel.fetch));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: { error: "forbidden", code: "NO_TEAM" } });
    expect(dbCallsContaining("FROM trade_docs")).toHaveLength(0);
    const body = kernel.calls[0]!.body as { datasets: Record<string, unknown[]> };
    expect(body.datasets.trade_docs).toEqual([]);
    expect(body.datasets.later_docs).toEqual([]);
  });

  it("当前页为空 ⇒ 不查对账结论（同旧路径 if rows）", async () => {
    resetDb(dbStub(LIST, (query) => {
      if (query.includes("FROM trade_docs") && !query.includes("COUNT(*)")
          && query.includes("ORDER BY created_at DESC")) return [];
      return null;
    }));
    await callList(envWith(ON_LIST, kernelSpy().fetch));
    expect(dbCallsContaining("FROM trade_doc_render_checks")).toHaveLength(0);
    expect(dbCallsContaining("AND id>$3")).toHaveLength(0);
  });

  it("内核 4xx（query 非法 422）⇒ 原样回放，且 query 原样透传内核", async () => {
    const detail = { detail: [{ type: "int_parsing", loc: ["query", "page"], msg: "bad", input: "abc" }] };
    const kernel = kernelSpy(
      () => new Response(JSON.stringify({ status: 422, body: detail }), { status: 200 }),
    );
    const res = await callList(
      envWith(ON_LIST, kernel.fetch),
      { url: "http://testserver/api/v1/trade-docs?page=abc" },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(detail);
    const body = kernel.calls[0]!.body as { request: { query: Record<string, unknown> } };
    expect(body.request.query.page).toBe("abc");
  });
});

describe("P3 trade-docs 详情 · 开关 on：TS 供数 → 内核纯投影 → 原样回放", () => {
  beforeEach(() => {
    resetDb(dbStub(DETAIL));
  });

  it("SQL/参数/payload/回放全部与 fixture 一致", async () => {
    const kernel = kernelSpy();
    const res = await callDetail(envWith(ON_DETAIL, kernel.fetch));
    expect(res.status).toBe(200);

    expect(TRADE_DOC_COLUMNS).toBe(DETAIL.facade.trade_docs_detail!.columns);
    const rowCall = dbCallsContaining("FROM trade_docs")[0]!;
    expect(norm(rowCall.query)).toBe(DETAIL.facade.trade_docs_detail!.sql);
    expect(rowCall.params).toEqual(DETAIL.facade.trade_docs_detail!.params);
    // 详情 SQL 没有作用域谓词（可见性是行级纯判定）
    expect(norm(rowCall.query)).not.toContain("team_id = $");
    expect(tradeDocsDetailSql("tenant_id = $1 AND id = $2"))
      .toBe(DETAIL.facade.trade_docs_detail!.sql);
    const linksCall = dbCallsContaining("FROM entity_links")[0]!;
    expect(norm(linksCall.query)).toBe(DETAIL.facade.entity_links!.sql);
    expect(linksCall.params).toEqual(DETAIL.facade.entity_links!.params);
    expect(norm(dbCallsContaining("AND id>$3")[0]!.query))
      .toBe(DETAIL.facade.later_docs_detail!.sql);
    expect(TRADE_DOC_LINKS_SQL).toBe(DETAIL.facade.entity_links!.sql);

    const body = kernel.calls[0]!.body as { request: unknown; datasets: unknown };
    expect(body.request).toEqual(DETAIL.request);
    expect(body.datasets).toEqual(DETAIL.datasets);
    expect(await res.json()).toEqual(DETAIL.response);
  });

  it("详情不存在 ⇒ 不查 links/later（同旧路径 404 前不发查询）", async () => {
    resetDb(dbStub(DETAIL, (query) => (
      query.includes("FROM trade_docs") && query.includes("WHERE tenant_id = $1 AND id = $2")
        ? [] : null)));
    const res = await callDetail(envWith(ON_DETAIL, kernelSpy().fetch));
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM entity_links")).toHaveLength(0);
    expect(dbCallsContaining("AND id>$3")).toHaveLength(0);
  });

  it("quote_id 优先于 order_id（逐行 later 检查的分支与旧路径一致）", async () => {
    const quoteDoc = { ...(DETAIL.datasets.trade_docs![0]!), quote_id: 77, order_id: 21 };
    resetDb(dbStub(DETAIL, (query) => (
      query.includes("WHERE tenant_id = $1 AND id = $2") ? [rawDocRow(quoteDoc)] : null)));
    await callDetail(envWith(ON_DETAIL, kernelSpy().fetch));
    const laterCall = dbCallsContaining("AND id>$3")[0]!;
    expect(norm(laterCall.query)).toBe(TRADE_DOC_LATER_QUOTE_SQL);
    expect(laterCall.params).toEqual(["default", 77, 11]);
  });

  it("非整数 doc_id ⇒ 交旧路径裁决（不自拼第二份 422）", async () => {
    const kernel = kernelSpy();
    const res = await callDetail(
      envWith(ON_DETAIL, kernel.fetch),
      { url: "http://testserver/api/v1/trade-docs/abc" },
    );
    expect(res.status).toBe(200);
    expect(kernel.calls).toHaveLength(1);
    expect(kernel.calls[0]!.path).toBe("/api/v1/trade-docs/abc");
  });
});

describe("P3 trade-docs 切片 · 回退 / 鉴权 / 异常 / 路由面", () => {
  it("AUTH_DB_SPLIT 缺失（默认 off）⇒ 不取数、原样透传旧端点", async () => {
    const kernel = kernelSpy();
    const res = await callList(envWith({}, kernel.fetch));
    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM trade_docs")).toHaveLength(0);
    expect(kernel.calls[0]!.path).toBe("/api/v1/trade-docs");
  });

  it("白名单未命中 ⇒ 旧透传（列表/详情都一样）", async () => {
    const kernel = kernelSpy();
    const env = { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: "quotes.list" };
    await callList(envWith(env, kernel.fetch));
    await callDetail(envWith(env, kernel.fetch));
    expect(kernel.calls.map((c) => c.path)).toEqual([
      "/api/v1/trade-docs", "/api/v1/trade-docs/11",
    ]);
    expect(dbCallsContaining("FROM trade_docs")).toHaveLength(0);
  });

  it("匿名 ⇒ 401，不打 DB / 内核", async () => {
    const kernel = kernelSpy();
    const res = await callList(envWith(ON_LIST, kernel.fetch), { authorized: false });
    expect(res.status).toBe(401);
    expect(dbCallsContaining("FROM trade_docs")).toHaveLength(0);
    expect(kernel.calls).toHaveLength(0);
  });

  it("工位闸门 404（非信封形状）⇒ 原样回放", async () => {
    const gate = {
      error: "not_found", code: "WORKSTATION_NOT_SUBSCRIBED",
      workstation: "trade-docs", detail: "该工位未开通，请在“工位开通”里启用",
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
      if (query.includes("FROM trade_docs")) throw new Error("connection reset");
      return [];
    });
    const res2 = await callList(envWith(ON_LIST, kernelSpy().fetch));
    expect(res2.status).toBe(503);
    expect(((await res2.json()) as Record<string, unknown>).error).toBe("db_unavailable");
  });

  it("路由面：两个 GET 各恰好注册一次；dataset 归一函数", () => {
    const routes = (app.routes as Array<{ method: string; path: string }>).map(
      (r) => r.method.toUpperCase() + " " + r.path,
    );
    expect(routes.filter((r) => r === "GET /api/v1/trade-docs")).toHaveLength(1);
    expect(routes.filter((r) => r === "GET /api/v1/trade-docs/:doc_id")).toHaveLength(1);
    expect(ENGINE_ROUTE_IDS.tradeDocsList).toBe("trade-docs.list");
    expect(ENGINE_ROUTE_IDS.tradeDocsDetail).toBe("trade-docs.detail");
    expect(ENGINE_TRADE_DOCS_LIST_RPC).toBe("/api/v1/internal/engine/trade-docs/list");
    expect(ENGINE_TRADE_DOCS_DETAIL_RPC).toBe("/api/v1/internal/engine/trade-docs/detail");
    expect(tradeDocDatasetRow({ id: "11", order_id: "21", total_amount: "100.00" }).id).toBe(11);
    expect(tradeDocDatasetRow({ total_amount: "100.00" }).total_amount).toBe(100);
    expect(tradeDocDatasetRow({ with_seal: false }).with_seal).toBe(false);
  });
});
