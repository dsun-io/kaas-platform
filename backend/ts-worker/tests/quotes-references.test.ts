// quotes 参考读（reference-price / cost-reference）门面直连 —— P3 只读迁移批次。
//
// 测的是 quotes-read 子应用（新加的两条路由与既有 quotations/tax-archives 共用同一 app）。
// 真源：backend/worker/src/quote_api.py:2420-2512（聚合全在 SQL）、:2515-2593（SQL + 纯中位数）。
//
// 覆盖：on 直连（形状 + SQL/参数逐字 + scope 谓词按角色/团队展开）/ off 逐字透传 /
//       422（缺 identity、spec 非法、days 越界）/ 中位数奇偶 / 401 / DB 失败 503。
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { DB_UNAVAILABLE_MESSAGE } from "../src/hot-read";
import quotesReadRoutes from "../src/routes/quotes-read";
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

const app = new Hono<{ Bindings: Env }>();
app.route("/", quotesReadRoutes);

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 9, email: "staff@qa.test", display_name: "Staff",
    account_type: "internal", role: "user", status: "active", team_id: 4,
    console_access: true, plan: "free", is_tenant_admin: false, ...overrides,
  };
}
const ADMIN_ROW: DbRow = { role: "admin" };

function kernelSpy(flag: Record<string, unknown> = {}) {
  const seen: Array<{ method: string; path: string; search: string }> = [];
  const fetch = vi.fn(async (input: Request | string) => {
    const req = input instanceof Request ? input : new Request(input);
    const url = new URL(req.url);
    seen.push({ method: req.method, path: url.pathname, search: url.search });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const env = makeTestEnv({ KERNEL: { fetch: fetch as never }, ...flag });
  return { seen, fetch, env };
}
const onEnv = (flag: Record<string, unknown> = {}) => kernelSpy({ AUTH_DB_SPLIT: "on", ...flag });

async function request(
  path: string,
  user: DbRow | null,
  env: ReturnType<typeof makeTestEnv>,
): Promise<Response> {
  const headers = new Headers();
  if (user !== null) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { headers }, env);
}

const REF_SELECT =
  "SELECT count(*) AS n,"
  + " avg(i.unit_price) AS avg, min(i.unit_price) AS min, max(i.unit_price) AS max,"
  + " percentile_cont(0.5) WITHIN GROUP (ORDER BY i.unit_price) AS median,"
  + " max(q.created_at) AS last_at"
  + " FROM quote_order_items i JOIN quote_orders q"
  + "   ON q.tenant_id = i.tenant_id AND q.id = i.quote_order_id"
  + " WHERE i.tenant_id=$1 AND q.customer_id=$2"
  + " AND i.unit_price IS NOT NULL";
const SCOPE_MEMBER = " AND (q.owner_id = $5 OR q.owner_scope = 'tenant' OR q.team_id = $6)";

type StubOptions = {
  user?: DbRow;
  aggregate?: DbRow;
  sameCost?: DbRow[];
  costRows?: DbRow[];
};

function dbStub(options: StubOptions): (query: string) => DbRow[] {
  return (query: string): DbRow[] => {
    if (query.includes("FROM users WHERE id")) return options.user ? [options.user] : [];
    if (query.includes("percentile_cont(0.5)")) {
      return [options.aggregate ?? {
        n: "0", avg: null, min: null, max: null, median: null, last_at: null,
      }];
    }
    if (query.includes("spec_snapshot->'specs' = $3::jsonb")) return options.sameCost ?? [];
    if (query.includes("interval '30 days'")) return options.costRows ?? [];
    return [];
  };
}

beforeEach(() => {
  resetDb(() => []);
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/quotes/reference-price（quote_api.py:2420-2512）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/quotes/reference-price（P3 直连）", () => {
  it("开关 on（成员）：聚合值投影 + SQL/参数逐字（含 scope 谓词）", async () => {
    resetDb(dbStub({
      user: userRow(),
      aggregate: {
        n: "3", avg: "12.5000", min: "10.0000", max: "15.0000",
        median: "12.5000", last_at: new Date("2026-10-01T02:00:00Z"),
      },
    }));
    const spy = onEnv();

    const res = await request(
      "/api/v1/quotes/reference-price?customer_id=5&product_key=field_fence",
      userRow(), spy.env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      customer_id: 5,
      product_name: "",
      days: 180,
      spec_matched: false,
      count: 3,
      avg: 12.5,
      min: 10,
      max: 15,
      median: 12.5,
      last_at: "2026-10-01T02:00:00.000+00:00",
    });
    const call = dbCallsContaining("percentile_cont(0.5)")[0]!;
    expect(call.query).toBe(
      REF_SELECT
      + " AND (i.spec_snapshot->>'product_key' = $3"
      + " OR (i.spec_snapshot->>'product_key' IS NULL"
      + "     AND (i.product_name IN ("
      + "           SELECT j.product_name FROM quote_order_items j"
      + "           WHERE j.tenant_id = $1"
      + "             AND j.spec_snapshot->>'product_key' = $3"
      + "             AND j.product_name IS NOT NULL))))"
      + " AND q.created_at >= now() - ($4 || ' days')::interval"
      + SCOPE_MEMBER,
    );
    expect(call.params).toEqual(["default", 5, "field_fence", 180, "9", 4]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("管理员：不加 scope 谓词（参数更短）", async () => {
    resetDb(dbStub({ user: userRow(ADMIN_ROW) }));
    const spy = onEnv();

    await request(
      "/api/v1/quotes/reference-price?customer_id=5&product_key=field_fence&days=30",
      userRow(ADMIN_ROW), spy.env,
    );

    const call = dbCallsContaining("percentile_cont(0.5)")[0]!;
    expect(call.query).not.toContain("q.owner_id");
    expect(call.params).toEqual(["default", 5, "field_fence", 30]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("key + name（回落）与仅 name（旧调用）两种 identity 参数顺序", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    await request(
      "/api/v1/quotes/reference-price?customer_id=5&product_key=field_fence&product_name=Field+Fence",
      userRow(), spy.env,
    );
    const withName = dbCallsContaining("percentile_cont(0.5)")[0]!;
    // key=$3、name=$4（回落 OR i.product_name = $4）、days=$5、scope=$6/$7
    expect(withName.query).toContain(" OR i.product_name = $4");
    expect(withName.params).toEqual(["default", 5, "field_fence", "Field Fence", 180, "9", 4]);

    resetDb(dbStub({ user: userRow() }));
    await request(
      "/api/v1/quotes/reference-price?customer_id=5&product_name=Field+Fence",
      userRow(), spy.env,
    );
    const nameOnly = dbCallsContaining("percentile_cont(0.5)")[0]!;
    expect(nameOnly.query).toContain(" AND i.product_name = $3");
    expect(nameOnly.params).toEqual(["default", 5, "Field Fence", 180, "9", 4]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("spec 给了：先验 JSON 形状，再作为 $n::jsonb 精确匹配（spec_matched=true）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const spec = JSON.stringify({ size_a: 1.2 });
    await request(
      "/api/v1/quotes/reference-price?customer_id=5&product_key=field_fence&spec="
      + encodeURIComponent(spec),
      userRow(), spy.env,
    );

    const call = dbCallsContaining("percentile_cont(0.5)")[0]!;
    expect(call.query).toContain(" AND i.spec_snapshot = $5::jsonb");
    expect(call.params).toEqual(["default", 5, "field_fence", 180, spec, "9", 4]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("缺 product_name/product_key → 422；spec 非法 JSON → 422；days 越界 → 422", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const missing = await request("/api/v1/quotes/reference-price?customer_id=5", userRow(), spy.env);
    expect(missing.status).toBe(422);
    expect(await missing.json()).toEqual({
      detail: {
        error: "validation_error",
        message: "product_name 或 product_key 至少给一个",
      },
    });

    const badSpec = await request(
      "/api/v1/quotes/reference-price?customer_id=5&product_key=k&spec=%7Bbad",
      userRow(), spy.env,
    );
    expect(badSpec.status).toBe(422);
    expect(await badSpec.json()).toEqual({
      detail: { error: "validation_error", message: "spec must be a JSON object" },
    });

    expect((await request(
      "/api/v1/quotes/reference-price?customer_id=5&product_key=k&days=0", userRow(), spy.env,
    )).status).toBe(422);
    expect((await request(
      "/api/v1/quotes/reference-price?customer_id=5&product_key=k&days=731", userRow(), spy.env,
    )).status).toBe(422);
    expect(dbCallsContaining("percentile_cont(0.5)")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传（query 逐字）", async () => {
    const spy = kernelSpy();

    const res = await request(
      "/api/v1/quotes/reference-price?customer_id=5&product_key=k&days=30",
      userRow(), spy.env,
    );

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([{
      method: "GET", path: "/api/v1/quotes/reference-price",
      search: "?customer_id=5&product_key=k&days=30",
    }]);
    expect(dbState.calls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/quotes/cost-reference（quote_api.py:2515-2593）
// ══════════════════════════════════════════════════════════════════════════════

const SPEC = JSON.stringify({ size_a: 1.2, size_unit: "m" });
const SPEC_URL = encodeURIComponent(SPEC);
const COST_SAME_SQL =
  "SELECT i.cost_override, i.spec_snapshot, q.quote_no, q.created_at"
  + " FROM quote_order_items i JOIN quote_orders q"
  + "   ON q.tenant_id = i.tenant_id AND q.id = i.quote_order_id"
  + " WHERE i.tenant_id=$1 AND i.spec_snapshot->>'product_key'=$2"
  + "   AND i.cost_override IS NOT NULL"
  + "   AND i.spec_snapshot->'specs' = $3::jsonb"
  + " AND (q.owner_id = $4 OR q.owner_scope = 'tenant' OR q.team_id = $5)"
  + " ORDER BY q.created_at DESC, i.id DESC LIMIT 1";

function costRow(overrides: DbRow = {}): DbRow {
  return {
    cost_override: "12.500000",
    spec_snapshot: { cost_unit: "kg", specs: { size_a: 1.2, size_unit: "m" }, product_key: "field_fence" },
    quote_no: "QT-1",
    created_at: new Date("2026-10-02T00:00:00Z"),
    ...overrides,
  };
}

describe("GET /api/v1/quotes/cost-reference（P3 直连）", () => {
  it("同规格命中 → source=latest（SQL/参数逐字 + 快照原样返回）", async () => {
    resetDb(dbStub({ user: userRow(), sameCost: [costRow()] }));
    const spy = onEnv();

    const res = await request(
      "/api/v1/quotes/cost-reference?product_key=field_fence&spec=" + SPEC_URL,
      userRow(), spy.env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as DbRow;
    expect(body.reference).toMatchObject({
      cost: 12.5, cost_unit: "kg", source: "latest", sample_count: 1,
      as_of: "2026-10-02T00:00:00.000+00:00", quote_no: "QT-1",
    });
    const call = dbCallsContaining("spec_snapshot->'specs' = $3::jsonb")[0]!;
    expect(call.query).toBe(COST_SAME_SQL);
    expect(call.params).toEqual(["default", "field_fence", SPEC, "9", 4]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("未命中 → 近 30 天中位数（奇数取中间；source=median_30d）", async () => {
    resetDb(dbStub({
      user: userRow(),
      sameCost: [],
      costRows: [
        costRow({ cost_override: "30", quote_no: "QT-3" }),
        costRow({ cost_override: "10", quote_no: "QT-1" }),
        costRow({ cost_override: "20", quote_no: "QT-2" }),
      ],
    }));
    const spy = onEnv();

    const res = await request(
      "/api/v1/quotes/cost-reference?product_key=field_fence&spec=" + SPEC_URL,
      userRow(), spy.env,
    );

    expect(res.status).toBe(200);
    const reference = ((await res.json()) as { reference: DbRow }).reference;
    // Python：sorted(costs) 后 n//2 → 奇数取正中
    expect(reference.cost).toBe(20);
    expect(reference.source).toBe("median_30d");
    expect(reference.sample_count).toBe(3);
    expect(reference.quote_no).toBe("QT-3");   // 最近一条（rows[0]）
    const rows = dbCallsContaining("interval '30 days'")[0]!;
    expect(rows.params).toEqual(["default", "field_fence", "9", 4]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("偶数样本中位数 = 中间两值均值（与 Python 逐字同算法）", async () => {
    resetDb(dbStub({
      user: userRow(),
      sameCost: [],
      costRows: [costRow({ cost_override: "30" }), costRow({ cost_override: "10" })],
    }));
    const spy = onEnv();

    const res = await request(
      "/api/v1/quotes/cost-reference?product_key=k&spec=" + SPEC_URL, userRow(), spy.env,
    );

    const reference = ((await res.json()) as { reference: DbRow }).reference;
    expect(reference.cost).toBe(20);   // (10 + 30) / 2
    expect(reference.sample_count).toBe(2);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("两路都空 → {reference: null}", async () => {
    resetDb(dbStub({ user: userRow(), sameCost: [], costRows: [] }));
    const spy = onEnv();

    const res = await request(
      "/api/v1/quotes/cost-reference?product_key=k&spec=" + SPEC_URL, userRow(), spy.env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reference: null });
  });

  it("spec 非法 JSON 或非对象 → 422 INVALID_SPEC（不查库）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const bad = await request(
      "/api/v1/quotes/cost-reference?product_key=k&spec=%7Bbad", userRow(), spy.env,
    );
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({
      detail: { error: "validation", code: "INVALID_SPEC", detail: "spec 必须是 JSON 对象" },
    });

    const arraySpec = await request(
      "/api/v1/quotes/cost-reference?product_key=k&spec=" + encodeURIComponent("[1,2]"),
      userRow(), spy.env,
    );
    expect(arraySpec.status).toBe(422);
    expect(dbCallsContaining("cost_override")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传（query 逐字）", async () => {
    const spy = kernelSpy();

    const res = await request(
      "/api/v1/quotes/cost-reference?product_key=k&spec=" + SPEC_URL, userRow(), spy.env,
    );

    expect(res.status).toBe(200);
    expect(spy.seen[0]!.path).toBe("/api/v1/quotes/cost-reference");
    expect(spy.seen[0]!.search).toBe("?product_key=k&spec=" + SPEC_URL);
    expect(dbState.calls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 401 / DB 失败
// ══════════════════════════════════════════════════════════════════════════════

describe("401：开关 on 时未鉴权不触达 DB / 内核", () => {
  const paths = [
    "/api/v1/quotes/reference-price?customer_id=5&product_key=k",
    "/api/v1/quotes/cost-reference?product_key=k&spec=" + SPEC_URL,
  ];
  for (const path of paths) {
    it(`${path.split("?")[0]} 无 token → 401`, async () => {
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
    "/api/v1/quotes/reference-price?customer_id=5&product_key=k",
    "/api/v1/quotes/cost-reference?product_key=k&spec=" + SPEC_URL,
  ];
  for (const path of paths) {
    it(`${path.split("?")[0]}：查询抛错 → 503`, async () => {
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
