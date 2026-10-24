/**
 * P3 批次A（扩权）：quotes / tax 域**只读**端点门面直连（AUTH_DB_SPLIT=`on`）。
 *
 * 真源：backend/worker/src/main.py:2504（GET /quotations）、
 *       backend/worker/src/tax_archives.py:202（GET /tax-archives）、
 *       backend/worker/src/tax_archives.py:372（GET /product-tax-rates）。
 * 列类型真源：backend/orchestrator/app/db/{models,tax_models}.py。
 *
 * 与 P0 同一套断言口径：
 * - 开关 on：200 且 env.KERNEL.fetch **一次都不被调用**；SQL/参数/排序逐字对照；
 * - 开关 off（默认）：仍走 KERNEL.fetch，path/search 与 createProxyApp 透传逐字一致；
 * - **只注册 GET**：同前缀的 POST 仍落到后面的透传 mount（写路径零改动）；
 * - 401：on 时未鉴权不打 DB/内核；off 时保持今天的「交给内核裁决」语义（不新增门面 401）；
 * - TS-DB 失败 → 503 {error:"db_unavailable"}。
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

// ── 脚手架（与 tests/p0-hot-reads.test.ts 同一套）────────────────────────────

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

function iso(text: string): string {
  return new Date(text).toISOString().replace("Z", "+00:00");
}

function dbStub(rows: {
  user?: DbRow;
  quotations?: DbRow[];
  quotationsTotal?: DbRow[];
  taxArchives?: DbRow[];
  productTaxRates?: DbRow[];
}): (query: string) => DbRow[] {
  return (query: string): DbRow[] => {
    if (query.includes("FROM users WHERE id")) return rows.user ? [rows.user] : [];
    if (query.includes("SELECT COUNT(*) FROM quotations")) return rows.quotationsTotal ?? [{ count: "0" }];
    if (query.includes("FROM quotations")) return rows.quotations ?? [];
    if (query.includes("FROM tax_archives")) return rows.taxArchives ?? [];
    if (query.includes("FROM product_tax_rates")) return rows.productTaxRates ?? [];
    return [];
  };
}

beforeEach(() => {
  resetDb(() => []);
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/quotations（main.py:2504-2543）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/quotations（P3 直连）", () => {
  const QUOTATION_ROW: DbRow = {
    id: "71",
    customer_id: "3",
    product_category: "gouhuawang",
    product_spec: { height: 1.2, wire: 2.5 },
    spec_hash: "abc123",
    unit_price: "12.5000",
    currency: "USD",
    unit: "roll",
    discount: "0.0500",
    min_quantity: 100,
    source: "manual",
    notes: "第一次报价",
    effective_from: new Date("2026-09-01T00:00:00Z"),
    created_at: new Date("2026-09-01T08:00:00Z"),
  };

  it("开关 on：200 + 形状与内核一致（id 字符串、金额数、JSONB 已解码）+ 不经内核", async () => {
    resetDb(dbStub({
      user: userRow(),
      quotations: [QUOTATION_ROW],
      quotationsTotal: [{ count: "1" }],
    }));
    const spy = onEnv();

    const res = await request("/api/v1/quotations", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          id: "71",
          customer_id: "3",
          product_category: "gouhuawang",
          product_spec: { height: 1.2, wire: 2.5 },
          spec_hash: "abc123",
          unit_price: 12.5,
          currency: "USD",
          unit: "roll",
          discount: 0.05,
          min_quantity: 100,
          source: "manual",
          notes: "第一次报价",
          effective_from: iso("2026-09-01T00:00:00Z"),
          created_at: iso("2026-09-01T08:00:00Z"),
        },
      ],
      total: 1,
    });
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("SQL 逐字对照：筛选参数顺序 + 排序 + limit 夹取（max(1,min(limit,500))）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    await request(
      "/api/v1/quotations?customer_id=3&product_category=gouhuawang&spec_hash=abc123&limit=5000",
      userRow(),
      spy.env,
    );

    const call = dbCallsContaining("FROM quotations WHERE")[0]!;
    expect(call.query).toContain(
      "SELECT id, customer_id, product_category, product_spec, spec_hash, unit_price,"
      + " currency, unit, discount, min_quantity, source, notes, effective_from, created_at"
      + " FROM quotations WHERE tenant_id = $1 AND customer_id = $2"
      + " AND product_category = $3 AND spec_hash = $4 ORDER BY effective_from DESC LIMIT 500",
    );
    expect(call.params).toEqual(["default", "3", "gouhuawang", "abc123"]);

    const total = dbCallsContaining("SELECT COUNT(*) FROM quotations WHERE")[0]!;
    expect(total.query).toBe(
      "SELECT COUNT(*) FROM quotations WHERE tenant_id = $1 AND customer_id = $2"
      + " AND product_category = $3 AND spec_hash = $4",
    );
    expect(total.params).toEqual(["default", "3", "gouhuawang", "abc123"]);

    // limit=0 → 夹到 1（Python max(1, ...)）
    resetDb(dbStub({ user: userRow() }));
    await request("/api/v1/quotations?limit=0", userRow(), spy.env);
    expect(dbCallsContaining("FROM quotations WHERE")[0]!.query).toContain("LIMIT 1");
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传（path/search 逐字，含筛选与 limit）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/quotations?customer_id=3&limit=5", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([
      { method: "GET", path: "/api/v1/quotations", search: "?customer_id=3&limit=5" },
    ]);
  });

  it("只注册 GET：同前缀 POST 仍走透传（写路径零改动）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/quotations", userRow(), spy.env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer_id: "3", product_category: "x" }),
    });

    expect(res.status).toBe(200);
    expect(spy.seen).toHaveLength(1);
    expect(spy.seen[0]!.method).toBe("POST");
    expect(spy.seen[0]!.path).toBe("/api/v1/quotations");
  });

  it("开关 off 且无 token：保持今天的「交给内核裁决」（门面不新增 401）", async () => {
    const spy = kernelSpy();

    const res = await request("/api/v1/quotations", null, spy.env);

    expect(res.status).toBe(200);
    expect(spy.seen).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/tax-archives（tax_archives.py:202-215）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/tax-archives（P3 直连）", () => {
  const ARCHIVE_ROW: DbRow = {
    id: "81",
    code: "TAX-20261001-1",
    name: "默认税档",
    effective_from: new Date("2026-10-01T00:00:00Z"),
    effective_to: null,
    tax_values: { output_vat_rate: 0.13, misc_fee_rate: 0.03 },
    source: "manual",
    status: "active",
    created_at: new Date("2026-10-01T08:00:00Z"),
    updated_at: new Date("2026-10-01T08:00:00Z"),
  };

  it("开关 on：200 + 形状（DATE 列只出日期、tax_values 对象）+ 本团队谓词 + 不经内核", async () => {
    resetDb(dbStub({ user: userRow(), taxArchives: [ARCHIVE_ROW] }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          id: 81,
          code: "TAX-20261001-1",
          name: "默认税档",
          effective_from: "2026-10-01",
          effective_to: null,
          tax_values: { output_vat_rate: 0.13, misc_fee_rate: 0.03 },
          source: "manual",
          status: "active",
          created_at: iso("2026-10-01T08:00:00Z"),
          updated_at: iso("2026-10-01T08:00:00Z"),
        },
      ],
      total: 1,
    });
    const call = dbCallsContaining("FROM tax_archives")[0]!;
    expect(call.query).toBe(
      "SELECT * FROM tax_archives WHERE tenant_id = $1 AND team_id = $2 AND status = 'active'"
      + " ORDER BY effective_from DESC NULLS LAST, updated_at DESC",
    );
    expect(call.params).toEqual(["default", 4]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("include_inactive：管理员放行全部状态；非管理员仍只看 active", async () => {
    resetDb(dbStub({ user: userRow(ADMIN_ROW) }));
    const spy = onEnv();

    await request("/api/v1/tax-archives?include_inactive=true", userRow(ADMIN_ROW), spy.env);
    const adminCall = dbCallsContaining("FROM tax_archives")[0]!;
    expect(adminCall.query).not.toContain("status = 'active'");
    expect(adminCall.params).toEqual(["default", 4]);

    resetDb(dbStub({ user: userRow() }));
    await request("/api/v1/tax-archives?include_inactive=true", userRow(), spy.env);
    const memberCall = dbCallsContaining("FROM tax_archives")[0]!;
    expect(memberCall.query).toContain("AND status = 'active'");
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("include_inactive 非法值 → 422（不静默当 false）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives?include_inactive=maybe", userRow(), spy.env);

    expect(res.status).toBe(422);
    expect(dbCallsContaining("FROM tax_archives")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/tax-archives?include_inactive=true", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([
      { method: "GET", path: "/api/v1/tax-archives", search: "?include_inactive=true" },
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/product-tax-rates（tax_archives.py:372-383）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/product-tax-rates（P3 直连）", () => {
  const RATE_ROW: DbRow = {
    id: "91",
    product_key: "field_fence",
    input_vat_rate: "0.130000",
    rebate_rate: "0.130000",
    status: "active",
    created_at: new Date("2026-10-01T08:00:00Z"),
    updated_at: new Date("2026-10-01T08:00:00Z"),
  };

  it("开关 on：200 + 7 键投影（税率显式转数）+ 排序 product_key ASC + 不经内核", async () => {
    resetDb(dbStub({ user: userRow(), productTaxRates: [RATE_ROW] }));
    const spy = onEnv();

    const res = await request("/api/v1/product-tax-rates", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          id: 91,
          product_key: "field_fence",
          input_vat_rate: 0.13,
          rebate_rate: 0.13,
          status: "active",
          created_at: iso("2026-10-01T08:00:00Z"),
          updated_at: iso("2026-10-01T08:00:00Z"),
        },
      ],
      total: 1,
    });
    const call = dbCallsContaining("FROM product_tax_rates")[0]!;
    expect(call.query).toBe(
      "SELECT * FROM product_tax_rates WHERE tenant_id = $1 AND status = 'active'"
      + " AND team_id = $2 ORDER BY product_key ASC",
    );
    expect(call.params).toEqual(["default", 4]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/product-tax-rates", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([
      { method: "GET", path: "/api/v1/product-tax-rates", search: "" },
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 401（on 时门面直接拦）与 DB 故障
// ══════════════════════════════════════════════════════════════════════════════

describe("401：开关 on 时未鉴权不触达 DB / 内核", () => {
  const paths = [
    "/api/v1/quotations",
    "/api/v1/tax-archives",
    "/api/v1/product-tax-rates",
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
  const paths = [
    "/api/v1/quotations",
    "/api/v1/tax-archives",
    "/api/v1/product-tax-rates",
  ];

  for (const path of paths) {
    it(`${path}：查询抛错 → 503（不是 500、也不是 502 kernel_unavailable）`, async () => {
      resetDb((query) => {
        if (query.includes("FROM users WHERE id")) return [userRow()];
        throw new Error("hyperdrive down");
      });
      const spy = onEnv();

      const res = await request(path, userRow(), spy.env);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "db_unavailable",
        message: DB_UNAVAILABLE_MESSAGE,
        status: 503,
        retryable: true,
      });
      expect(spy.fetch).not.toHaveBeenCalled();
    });
  }
});
