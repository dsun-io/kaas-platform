/**
 * market 品名对照 CRUD 路由测试（C36 #19；真源 = backend/worker/src/main.py:2030-2136）。
 *
 * 重点：
 * - 鉴权闸门（无 token → 401，先于任何 SQL）；
 * - GET 列表分页/筛选/排序/total（{items,total,page,page_size}）；
 * - PATCH 只更新显式字段（rawBody 键集）、空 body 422、404、唯一键 409；
 * - DELETE 204/404；tenant 恒为 default（每条 SQL 的租户参数）。
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import intelRoutes from "../src/routes/intel";
import { createToken } from "../src/session";
import {
  dbCallsContaining,
  dbState,
  FIXED_SECRET,
  resetDb,
  TEST_ENV,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

// index.ts 的挂载由 lead 统一做；测试用同形状的本地 app。
const app = new Hono();
app.route("/", intelRoutes);

const BASE = "/api/v1/market/name-mappings";

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

function mappingRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 11,
    tenant_id: "default",
    category_id: 3,
    region_code: "US",
    lang: "en",
    local_name: "Chain Link Fence",
    alt_names: ["chain link fencing"],
    hs_code: "7314.41",
    source: "manual",
    confidence: "high",
    is_verified: true,
    created_at: new Date("2026-10-23T04:00:00Z"),
    updated_at: new Date("2026-10-23T04:00:00Z"),
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

function withJson(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

/** 用户装载 + 按 SQL 片段返回列表/更新/删除结果。 */
function installDb(handler: (query: string, params: unknown[]) => DbRow[]): void {
  resetDb((query, params) => {
    if (query.includes("FROM users WHERE id")) return [userRow()];
    return handler(query, params);
  });
}

beforeEach(() => {
  resetDb(() => []);
});

describe("鉴权闸门（同现有 POST）", () => {
  it("无 token → 401，且不触库", async () => {
    for (const [path, init] of [
      [BASE, {}],
      [BASE + "/11", withJson("PATCH", { local_name: "x" })],
      [BASE + "/11", { method: "DELETE" }],
    ] as Array<[string, RequestInit]>) {
      const res = await request(path, null, init);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        detail: { error: "unauthorized", message: "Authentication required" },
      });
    }
    expect(dbState.calls).toHaveLength(0);
  });
});

describe("GET /api/v1/market/name-mappings", () => {
  it("默认分页 + 排序 + total 形状", async () => {
    const rows = [mappingRow(), mappingRow({ id: 12, local_name: "Welded Mesh" })];
    installDb((query) => {
      if (query.includes("SELECT COUNT(*)")) return [{ count: 2 }];
      if (query.includes("ORDER BY is_verified DESC")) return rows;
      return [];
    });

    const res = await request(BASE, userRow());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: DbRow[]; total: number; page: number; page_size: number;
    };
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(20);
    expect(body.items.map((item) => item.id)).toEqual([11, 12]);
    // 出参投影：BIGINT id → number，时间戳 isoformat（+00:00）
    expect(body.items[0]?.created_at).toBe("2026-10-23T04:00:00.000+00:00");

    const countCall = dbCallsContaining("SELECT COUNT(*)")[0];
    expect(countCall?.query).toContain("WHERE tenant_id = $1");
    expect(countCall?.params).toEqual(["default"]);
    const listCall = dbCallsContaining("ORDER BY is_verified DESC")[0];
    expect(listCall?.query).toContain("LIMIT $2 OFFSET $3");
    expect(listCall?.params).toEqual(["default", 20, 0]);
  });

  it("page/page_size 透传为 LIMIT/OFFSET", async () => {
    installDb((query) => {
      if (query.includes("SELECT COUNT(*)")) return [{ count: 0 }];
      if (query.includes("ORDER BY is_verified DESC")) return [];
      return [];
    });

    const res = await request(BASE + "?page=3&page_size=5", userRow());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: number; page_size: number; items: DbRow[] };
    expect(body.page).toBe(3);
    expect(body.page_size).toBe(5);
    expect(body.items).toEqual([]);
    expect(dbCallsContaining("ORDER BY is_verified DESC")[0]?.params).toEqual([
      "default", 5, 10,
    ]);
  });

  it("q/region_code/lang 筛选：q 双路径 ILIKE + region 大写 + 精确 lang", async () => {
    installDb((query) => {
      if (query.includes("SELECT COUNT(*)")) return [{ count: 1 }];
      if (query.includes("ORDER BY is_verified DESC")) return [mappingRow()];
      return [];
    });

    const res = await request(
      BASE + "?q=fence&region_code=us&lang=en&page=2&page_size=10", userRow());
    expect(res.status).toBe(200);

    const countCall = dbCallsContaining("SELECT COUNT(*)")[0];
    expect(countCall?.query).toContain("local_name ILIKE $2");
    expect(countCall?.query).toContain("jsonb_array_elements_text");
    expect(countCall?.query).toContain("region_code = $3");
    expect(countCall?.query).toContain("lang = $4");
    expect(countCall?.params).toEqual(["default", "%fence%", "US", "en"]);
    const listCall = dbCallsContaining("ORDER BY is_verified DESC")[0];
    expect(listCall?.query).toContain("LIMIT $5 OFFSET $6");
    expect(listCall?.params).toEqual(["default", "%fence%", "US", "en", 10, 10]);
  });

  it("空筛选参数 = 不筛选（只有 tenant 条件）", async () => {
    installDb((query) => {
      if (query.includes("SELECT COUNT(*)")) return [{ count: 0 }];
      return [];
    });

    const res = await request(BASE + "?q=&region_code=&lang=", userRow());
    expect(res.status).toBe(200);
    expect(dbCallsContaining("SELECT COUNT(*)")[0]?.params).toEqual(["default"]);
  });

  it("page_size 越界 → 422", async () => {
    installDb(() => []);
    for (const query of ["page=0", "page_size=0", "page_size=101"]) {
      const res = await request(BASE + "?" + query, userRow());
      expect(res.status).toBe(422);
    }
    expect(dbCallsContaining("SELECT COUNT(*)")).toHaveLength(0);
  });
});

describe("PATCH /api/v1/market/name-mappings/{id}", () => {
  it("只更新显式字段（含 falsy 的 is_verified），并显式 updated_at", async () => {
    installDb((query) => {
      if (query.includes("UPDATE market_product_name_mappings")) {
        return [mappingRow({ local_name: "Chain Link Fence Pro", is_verified: false })];
      }
      return [];
    });

    const res = await request(BASE + "/11", userRow(), withJson("PATCH", {
      local_name: "Chain Link Fence Pro",
      is_verified: false,
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DbRow;
    expect(body.local_name).toBe("Chain Link Fence Pro");
    expect(body.is_verified).toBe(false);

    const call = dbCallsContaining("UPDATE market_product_name_mappings")[0];
    expect(call?.query).toContain("local_name = $3");
    expect(call?.query).toContain("is_verified = $4");
    expect(call?.query).not.toContain("category_id");
    expect(call?.query).not.toContain("alt_names");
    expect(call?.query).toContain("updated_at = NOW()");
    expect(call?.query).toContain("WHERE tenant_id=$1 AND id=$2");
    expect(call?.params).toEqual(["default", 11, "Chain Link Fence Pro", false]);
  });

  it("region_code 大写 + alt_names JSONB + 显式 null 清空", async () => {
    installDb((query) => {
      if (query.includes("UPDATE market_product_name_mappings")) {
        return [mappingRow({ region_code: "EU", alt_names: ["cloture"], hs_code: null })];
      }
      return [];
    });

    const res = await request(BASE + "/11", userRow(), withJson("PATCH", {
      region_code: "eu",
      alt_names: ["cloture"],
      hs_code: null,
    }));
    expect(res.status).toBe(200);

    const call = dbCallsContaining("UPDATE market_product_name_mappings")[0];
    expect(call?.query).toContain("region_code = $3");
    expect(call?.query).toContain("alt_names = $4::jsonb");
    expect(call?.query).toContain("hs_code = $5");
    expect(call?.params).toEqual(["default", 11, "EU", '["cloture"]', null]);
  });

  it("空 body → 422 No fields to update（不执行 UPDATE）", async () => {
    installDb(() => []);
    const res = await request(BASE + "/11", userRow(), withJson("PATCH", {}));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ detail: "No fields to update" });
    expect(dbCallsContaining("UPDATE market_product_name_mappings")).toHaveLength(0);
  });

  it("只有未知字段 → 422（zod 剥掉后无白名单字段）", async () => {
    installDb(() => []);
    const res = await request(BASE + "/11", userRow(), withJson("PATCH", { foo: 1 }));
    expect(res.status).toBe(422);
    expect(dbCallsContaining("UPDATE market_product_name_mappings")).toHaveLength(0);
  });

  it("非法 JSON → 422 json_invalid", async () => {
    installDb(() => []);
    const res = await request(BASE + "/11", userRow(), withJson("PATCH", "{"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: Array<{ type: string }> };
    expect(body.detail[0]?.type).toBe("json_invalid");
  });

  it("不存在 / 非本 tenant → 404（UPDATE 带 tenant 条件）", async () => {
    installDb(() => []);
    const res = await request(BASE + "/99", userRow(), withJson("PATCH", {
      local_name: "x",
    }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: { error: "not_found", code: "NAME_MAPPING_NOT_FOUND" },
    });
    const call = dbCallsContaining("UPDATE market_product_name_mappings")[0];
    expect(call?.query).toContain("WHERE tenant_id=$1 AND id=$2");
    expect(call?.params.slice(0, 2)).toEqual(["default", 99]);
  });

  it("唯一键冲突（code 23505）→ 409", async () => {
    installDb((query) => {
      if (query.includes("UPDATE market_product_name_mappings")) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "uq_market_name_mappings"'),
          { code: "23505" },
        );
      }
      return [];
    });
    const res = await request(BASE + "/11", userRow(), withJson("PATCH", { lang: "zh" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      detail: { error: "conflict", code: "NAME_MAPPING_EXISTS" },
    });
  });

  it("唯一键冲突（只有 duplicate key 文案）→ 409", async () => {
    installDb((query) => {
      if (query.includes("UPDATE market_product_name_mappings")) {
        throw new Error('duplicate key value violates unique constraint "uq_market_name_mappings"');
      }
      return [];
    });
    const res = await request(BASE + "/11", userRow(), withJson("PATCH", { lang: "zh" }));
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/v1/market/name-mappings/{id}", () => {
  it("删除成功 → 204 无 body", async () => {
    installDb((query) => {
      if (query.includes("DELETE FROM market_product_name_mappings")) return [{ id: 11 }];
      return [];
    });
    const res = await request(BASE + "/11", userRow(), { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const call = dbCallsContaining("DELETE FROM market_product_name_mappings")[0];
    expect(call?.query).toContain("WHERE id=$1 AND tenant_id=$2");
    expect(call?.params).toEqual([11, "default"]);
  });

  it("不存在 / 非本 tenant → 404", async () => {
    installDb(() => []);
    const res = await request(BASE + "/99", userRow(), { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: { error: "not_found", code: "NAME_MAPPING_NOT_FOUND" },
    });
  });
});
