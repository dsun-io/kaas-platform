/**
 * P3 第八批金标（TS 侧）：GET /trade-docs/{doc_id}/facts + /consistency。
 *
 * 与 Python 侧 backend/worker/tests/test_engine_rpc_trade_docs_facts.py 读同一份 fixture。
 * 要点：门面按旧 SQL 逐字供数；facts 恒下发 tenant_products（旧路径按数据形状才查）；
 * consistency 的域判定是数据依赖的三处查询（order 列 → 边表 order → quote 链 → 自身）。
 */
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import {
  ENGINE_ROUTE_IDS,
  ENGINE_TRADE_DOCS_CONSISTENCY_RPC,
  ENGINE_TRADE_DOCS_FACTS_RPC,
  FACTS_TENANT_PRODUCTS_SQL,
  LINKED_ORDER_SQL,
  LINKED_QUOTE_SQL,
  TRADE_DOC_BY_ID_SQL,
  tradeDocFactsSql,
  tradeDocsByOrderSql,
  tradeDocsByQuoteSql,
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
  const file = path.join(__dirname, "..", "..", "ts-migration", "golden", "engine-" + name + ".fixture.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
}

const FACTS = loadFixture("trade-docs-facts");
const CONSISTENCY = loadFixture("trade-docs-consistency");

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

const BIGINT_COLS = ["id", "order_id", "customer_id", "quote_id", "team_id", "dst_id",
  "trade_doc_id"];

function rawDocRow(row: DbRow): DbRow {
  const out: DbRow = { ...row };
  for (const col of BIGINT_COLS) {
    if (out[col] !== null && out[col] !== undefined) out[col] = String(out[col]);
  }
  return out;
}

function dbStub(fixture: Fixture, over: (query: string) => DbRow[] | null = () => null) {
  return (query: string): DbRow[] => {
    const custom = over(query);
    if (custom !== null) return custom;
    if (query.includes("FROM users WHERE id")) return [userRow(fixture)];
    if (query.includes("FROM trade_doc_facts")) {
      return (fixture.datasets.trade_doc_facts ?? []).map((row) => ({
        ...row,
        confirmed_at: row.confirmed_at,
      }));
    }
    if (query.includes("FROM tenant_products")) {
      return (fixture.datasets.tenant_products ?? []).map((row) => ({
        ...row,
        team_id: row.team_id === null || row.team_id === undefined ? null : String(row.team_id),
      }));
    }
    if (query.includes("FROM entity_links")) return [];
    if (query.includes("FROM trade_docs")) {
      if (query.includes("AND id=$2")) {
        return (fixture.datasets.trade_docs ?? []).map(rawDocRow);
      }
      if (query.includes("AND order_id=$2")) {
        return (fixture.datasets.trade_docs_by_order ?? []).map(rawDocRow);
      }
      if (query.includes("AND quote_id=$2")) {
        return (fixture.datasets.trade_docs_by_quote ?? []).map(rawDocRow);
      }
      return [];
    }
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
    const fixture = call.path === FACTS.rpc ? FACTS : CONSISTENCY;
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

async function call(
  env: ReturnType<typeof makeTestEnv>,
  url: string,
  options: { authorized?: boolean } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorized !== false) {
    headers.set("Authorization", "Bearer " + (await createToken(FACTS.actor.id, FIXED_SECRET)));
  }
  return app.request("http://testserver" + url, { method: "GET", headers }, env);
}

beforeEach(() => {
  resetDb(dbStub(FACTS));
});

describe("P3 第八批 · facts", () => {
  it("SQL/参数/payload/回放与 fixture 逐字一致", async () => {
    resetDb(dbStub(FACTS));
    const kernel = kernelSpy();
    const res = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.docsFacts },
      kernel.fetch), "/api/v1/trade-docs/11/facts");
    expect(res.status).toBe(200);

    expect(norm(TRADE_DOC_BY_ID_SQL)).toBe(norm(FACTS.facade.trade_docs!.sql!));
    const docCall = dbCallsContaining("FROM trade_docs")[0]!;
    expect(norm(docCall.query)).toBe(norm(FACTS.facade.trade_docs!.sql!));
    expect(docCall.params).toEqual(FACTS.facade.trade_docs!.params);
    const factCall = dbCallsContaining("FROM trade_doc_facts")[0]!;
    expect(norm(factCall.query)).toBe(norm(FACTS.facade.trade_doc_facts!.sql!));
    expect(factCall.params).toEqual(FACTS.facade.trade_doc_facts!.params);
    const productCall = dbCallsContaining("FROM tenant_products")[0]!;
    expect(norm(productCall.query)).toBe(norm(FACTS.facade.tenant_products!.sql!));
    expect(productCall.params).toEqual(FACTS.facade.tenant_products!.params);
    expect(norm(FACTS_TENANT_PRODUCTS_SQL)).toBe(norm(FACTS.facade.tenant_products!.sql!));
    expect(norm(tradeDocFactsSql())).toBe(norm(FACTS.facade.trade_doc_facts!.sql!));

    const body = kernel.calls[0]!.body as { request: unknown; datasets: unknown };
    expect(body.request).toEqual(FACTS.request);
    expect(body.datasets).toEqual(FACTS.datasets);
    expect(await res.json()).toEqual(FACTS.response);
  });

  it("条件式时间戳：零微秒无小数；旧的恒 6 位写法零残留", () => {
    const sql = tradeDocFactsSql();
    expect(sql).not.toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.US\"+00:00\"'");
    const items = FACTS.response.items as Array<Record<string, unknown>>;
    const incoterm = items.find((i) => i["key"] === "incoterm")!;
    expect(String(incoterm.confirmed_at)).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
  });
});

describe("P3 第八批 · consistency", () => {
  it("order 列分支：SQL/参数/payload/回放与 fixture 逐字一致", async () => {
    resetDb(dbStub(CONSISTENCY));
    const kernel = kernelSpy();
    const res = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.docsConsistency },
      kernel.fetch), "/api/v1/trade-docs/12/consistency");
    expect(res.status).toBe(200);
    expect(norm(tradeDocsByOrderSql())).toBe(norm(CONSISTENCY.facade.trade_docs_by_order!.sql!));
    const byOrder = dbCallsContaining("AND order_id=$2")[0]!;
    expect(norm(byOrder.query)).toBe(norm(CONSISTENCY.facade.trade_docs_by_order!.sql!));
    expect(byOrder.params).toEqual(CONSISTENCY.facade.trade_docs_by_order!.params);
    expect(dbCallsContaining("FROM entity_links")).toHaveLength(0);   // 列有值 ⇒ 不查边表
    const body = kernel.calls[0]!.body as { datasets: unknown; request: unknown };
    expect(body.request).toEqual(CONSISTENCY.request);
    expect(body.datasets).toEqual(CONSISTENCY.datasets);
    expect(await res.json()).toEqual(CONSISTENCY.response);
  });

  it("order 列为空 ⇒ 先查边表 order 边，再查同 order 单证", async () => {
    const doc = { ...(CONSISTENCY.datasets.trade_docs![0]!), order_id: null };
    resetDb(dbStub(CONSISTENCY, (query) => (
      query.includes("AND id=$2") ? [rawDocRow(doc)] : null)));
    const kernel = kernelSpy();
    await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.docsConsistency },
      kernel.fetch), "/api/v1/trade-docs/12/consistency");
    const linkCalls = dbCallsContaining("FROM entity_links");
    // 边表 order 边没命中 ⇒ 再兜底查 quote 边（与旧 _domain_docs 的退化顺序一致）
    expect(linkCalls).toHaveLength(2);
    expect(norm(linkCalls[0]!.query)).toBe(norm(LINKED_ORDER_SQL));
    expect(norm(linkCalls[1]!.query)).toBe(norm(LINKED_QUOTE_SQL));
    const body = kernel.calls[0]!.body as { datasets: { linked_order_links: unknown[] } };
    expect(body.datasets.linked_order_links).toEqual([]);
  });

  it("order 链无单证 ⇒ 退化到 quote 链（边表 quote 兜底）", async () => {
    const doc = { ...(CONSISTENCY.datasets.trade_docs![0]!), order_id: null, quote_id: 9 };
    resetDb(dbStub(CONSISTENCY, (query) => (
      query.includes("AND id=$2") ? [rawDocRow(doc)] : null)));
    const kernel = kernelSpy();
    await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.docsConsistency },
      kernel.fetch), "/api/v1/trade-docs/12/consistency");
    expect(norm(tradeDocsByQuoteSql())).not.toBe("");
    expect(dbCallsContaining("AND quote_id=$2")).toHaveLength(1);
    expect(dbCallsContaining("FROM entity_links").length).toBeGreaterThanOrEqual(1);
  });

  it("非整数 doc_id ⇒ 交旧路径裁决", async () => {
    const kernel = kernelSpy();
    const res = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.docsFacts },
      kernel.fetch), "/api/v1/trade-docs/abc/facts");
    expect(res.status).toBe(200);
    expect(kernel.calls[0]!.path).toBe("/api/v1/trade-docs/abc/facts");
  });
});

describe("P3 第八批 · 回退 / 鉴权 / 异常", () => {
  it("开关 off / 白名单未命中 ⇒ 不取数、旧透传", async () => {
    for (const env of [
      {},
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: "quotes.list" },
    ]) {
      resetDb(dbStub(FACTS));
      const kernel = kernelSpy();
      const res = await call(envWith(env, kernel.fetch), "/api/v1/trade-docs/11/facts");
      expect(res.status).toBe(200);
      expect(dbCallsContaining("FROM trade_docs")).toHaveLength(0);
      expect(kernel.calls[0]!.path).toBe("/api/v1/trade-docs/11/facts");
    }
  });

  it("匿名 ⇒ 401，不打 DB / 内核", async () => {
    const kernel = kernelSpy();
    const res = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.docsFacts },
      kernel.fetch), "/api/v1/trade-docs/11/facts", { authorized: false });
    expect(res.status).toBe(401);
    expect(dbCallsContaining("FROM trade_docs")).toHaveLength(0);
    expect(kernel.calls).toHaveLength(0);
  });

  it("工位闸门 404 ⇒ 原样回放；内核 5xx ⇒ kernel_error；DB 失败 ⇒ 503", async () => {
    const gate = {
      error: "not_found", code: "WORKSTATION_NOT_SUBSCRIBED", workstation: "trade-docs",
      detail: "该工位未开通，请在“工位开通”里启用",
    };
    resetDb(dbStub(FACTS));
    const gateKernel = kernelSpy(() => new Response(JSON.stringify(gate), { status: 404 }));
    const gateRes = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.docsFacts },
      gateKernel.fetch), "/api/v1/trade-docs/11/facts");
    expect(gateRes.status).toBe(404);
    expect(await gateRes.json()).toEqual(gate);

    resetDb(dbStub(FACTS));
    const boomKernel = kernelSpy(() => new Response("boom", { status: 500 }));
    const boomRes = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.docsFacts },
      boomKernel.fetch), "/api/v1/trade-docs/11/facts");
    expect(boomRes.status).toBe(500);
    expect(((await boomRes.json()) as Record<string, unknown>).error).toBe("kernel_error");

    resetDb((query: string) => {
      if (query.includes("FROM users WHERE id")) return [userRow(FACTS)];
      if (query.includes("FROM trade_docs")) throw new Error("connection reset");
      return [];
    });
    const res = await call(envWith(
      { AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: ENGINE_ROUTE_IDS.docsFacts },
      kernelSpy().fetch), "/api/v1/trade-docs/11/facts");
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("db_unavailable");
  });

  it("路由面：两个 GET 各恰好注册一次；RPC 常量正确", () => {
    const routes = (app.routes as Array<{ method: string; path: string }>).map(
      (r) => r.method.toUpperCase() + " " + r.path,
    );
    expect(routes.filter((r) => r === "GET /api/v1/trade-docs/:doc_id/facts")).toHaveLength(1);
    expect(routes.filter((r) => r === "GET /api/v1/trade-docs/:doc_id/consistency"))
      .toHaveLength(1);
    expect(ENGINE_ROUTE_IDS.docsFacts).toBe("trade-docs.facts");
    expect(ENGINE_ROUTE_IDS.docsConsistency).toBe("trade-docs.consistency");
    expect(ENGINE_TRADE_DOCS_FACTS_RPC).toBe("/api/v1/internal/engine/trade-docs/facts");
    expect(ENGINE_TRADE_DOCS_CONSISTENCY_RPC)
      .toBe("/api/v1/internal/engine/trade-docs/consistency");
  });
});
