/**
 * intel 域路由测试（真源 = backend/worker/src/chain.py + main.py:946-1120,1712-1841）。
 *
 * 重点：
 * - 门面鉴权闸门（无 token → 401 信封，先于任何 SQL）；
 * - 工位订阅闸门（tenant_subscriptions 未开通 → 404 SUBSCRIPTION_REQUIRED）；
 * - 出参形状（intel/channels 的 free/paid 分组 + message；leads 创建的 raw 剔除与指数占位）；
 * - 引擎端点透传契约（请求原样转发 KERNEL，含 method/path，不读 body）。
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import intelRoutes from "../src/routes/intel";
import { createToken } from "../src/session";
import {
  FIXED_SECRET,
  makeTestEnv,
  resetDb,
  TEST_ENV,
  dbState,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

// index.ts 的挂载由 lead 统一做（本波不碰 index.ts）；测试用同形状的本地 app。
const app = new Hono();
app.route("/", intelRoutes);

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 7,
    email: "intel@qa.test",
    display_name: "Intel User",
    account_type: "internal",
    role: "sales",
    status: "active",
    team_id: 3,
    console_access: false,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

async function request(
  path: string,
  user: DbRow | null,
  init: RequestInit = {},
  env = TEST_ENV,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (user) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { ...init, headers }, env);
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  resetDb(() => []);
});

describe("intel 域鉴权闸门", () => {
  it("GET /api/v1/leadgen/regions 无 token → 401（Python 同信封）", async () => {
    const res = await request("/api/v1/leadgen/regions", null);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
    // 闸门在查库之前：没有任何 SQL 发出
    expect(dbState.calls).toHaveLength(0);
  });
});

describe("工位订阅闸门（chain.py:_require_sub）", () => {
  it("未开通 leadgen → 404 SUBSCRIPTION_REQUIRED（含 workstation/codes）", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      return [];
    });

    const res = await request("/api/v1/leadgen/runs", user);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: {
        error: "subscription_required",
        code: "SUBSCRIPTION_REQUIRED",
        workstation: "leadgen",
        codes: ["leadgen_starter", "leadgen_pro", "full_chain"],
      },
    });
    // 只到订阅判定为止：没有去查 leadgen_runs
    expect(dbState.calls.some((call) => call.query.includes("FROM leadgen_runs"))).toBe(false);
  });
});

describe("GET /api/v1/intel/channels（出参形状）", () => {
  it("按 tier 分组：free 原样 / paid 补 message（已开通/未开通）", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM intel_data_channels")) {
        return [
          { id: 1, name: "Customs Open Data", tier: "free", is_enabled: true },
          { id: 2, name: "Panjiva", tier: "paid", is_enabled: false },
          { id: 3, name: "ImportGenius", tier: "paid", is_enabled: true },
        ];
      }
      return [];
    });

    const res = await request("/api/v1/intel/channels", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      free_channels: [{ id: 1, name: "Customs Open Data", tier: "free", is_enabled: true }],
      paid_channels: [
        { id: 2, name: "Panjiva", tier: "paid", is_enabled: false, message: "未开通" },
        { id: 3, name: "ImportGenius", tier: "paid", is_enabled: true, message: "已开通" },
      ],
    });
  });
});

describe("POST /api/v1/leads（门面移植写侧）", () => {
  it("201：manual place_id 落库，响应剔除 raw 并补 demand/blank 占位", async () => {
    const user = userRow();
    const row: DbRow = {
      id: 21,
      place_id: "manual-abc",
      company_name: "Acme Fence",
      country: "US",
      fit_score: 80,
      fit_reasons: ["有邮箱 +40"],
      raw: { demo: true },
      crawl_status: "no_website",
      created_at: new Date("2026-10-01T00:00:00Z"),
      owner_id: "7",
      owner_scope: "tenant",
    };
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM tenant_subscriptions")) return [{ ok: 1 }];
      if (query.includes("SELECT id FROM lead_candidates")) return [];
      if (query.includes("INSERT INTO lead_candidates")) return [row];
      return [];
    });

    const res = await request("/api/v1/leads", user, postJson({ company_name: "Acme Fence" }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as DbRow;
    expect(body.raw).toBeUndefined();
    expect(body.demand_index).toBeNull();
    expect(body.blank_index).toBeNull();
    expect(body.company_name).toBe("Acme Fence");
    expect(body.created_at).toBe("2026-10-01T00:00:00.000+00:00");
    // place_id 由 sha256(company_name)[:16] 生成（chain.py:1376 同口径）
    const insert = dbState.calls.find((call) => call.query.includes("INSERT INTO lead_candidates"));
    expect(String(insert?.params[1])).toMatch(/^manual-[0-9a-f]{16}$/);
  });
});

describe("POST /api/v1/intel/import/csv（CSV 直译）", () => {
  it("逐行落库：坏行记入 error_details，不拖垮整批", async () => {
    const user = userRow();
    const inserted: unknown[][] = [];
    resetDb((query, params) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("INSERT INTO intel_shipments")) {
        inserted.push(params);
        return [];
      }
      return [];
    });
    const csv = [
      "shipper,consignee,product_desc,hs_code",
      "Acme Fence,Globex Wire,Mesh 7314,7314",
      "Bad Row Only",
      "",
    ].join("\n");
    const form = new FormData();
    form.append("file", new File([csv], "shipments.csv", { type: "text/csv" }));

    const res = await request("/api/v1/intel/import/csv", user, { method: "POST", body: form });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "success",
      processed: 2,
      inserted: 1,
      errors: 1,
      error_details: [{ row: 3, error: "缺少必填字段 (shipper/consignee/product_desc)" }],
    });
    expect(inserted).toHaveLength(1);
    // 列语义：tenant_id / created_by / source_ref(filename) / 表头映射后的值
    expect(inserted[0]?.slice(0, 3)).toEqual(["default", "7", "shipments.csv"]);
    // 列序 = CSV 表头顺序（Python dict 插入序，与 raw.items() 一致）
    expect(inserted[0]?.slice(3)).toEqual(["Acme Fence", "Globex Wire", "Mesh 7314", "7314"]);
  });
});

describe("引擎端点透传（禁止第二份实现）", () => {
  it("POST /api/v1/leads/{id}/crawl 原样转发 KERNEL（method/path 不变）", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));
    const seen: { url: string; method: string }[] = [];
    const env = makeTestEnv({
      KERNEL: {
        fetch: async (input: Request | string) => {
          const target = input instanceof Request ? input : new Request(input);
          seen.push({ url: target.url, method: target.method });
          return new Response(JSON.stringify({ result: { lead_id: 9, status: "success" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });

    const res = await request("/api/v1/leads/9/crawl", user, postJson({}), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { lead_id: 9, status: "success" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("https://kernel.internal/api/v1/leads/9/crawl");
  });

  it("GET /api/v1/leads（需求/空白指数在内核）→ 透传，内核 5xx 归一成 kernel_error", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () => new Response("boom", { status: 502 }),
      },
    });

    const res = await request("/api/v1/leads", user, {}, env);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "kernel_error",
      message: "boom",
      status: 502,
    });
  });
});
