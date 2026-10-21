/**
 * admin 域路由测试（真源 = main.py:2824-3077 + ws_admin_accounts.py + ws_admin_proposals.py）。
 *
 * 重点：
 * - 无 token → 401；
 * - 平台运营闸门（internal+管理员）→ 403 {"error":"forbidden","message":"Platform operator required"}；
 * - 账号治理闸门错误体只有 error 键（与平台运营闸门**不同**，逐字对齐 ws_admin_accounts.py:31）；
 * - feature flag 读取形状 = { 租户: { 开关: bool } }；写入门禁缺 flag_name → 422 detail 字符串；
 * - 禁自己 → 409 SELF_PROTECT。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { createToken } from "../src/session";
import { FIXED_SECRET, resetDb, TEST_ENV, type DbRow } from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 1,
    email: "ops@kaas.test",
    display_name: "Ops",
    account_type: "internal",
    role: "system_admin",
    status: "active",
    team_id: null,
    console_access: true,
    plan: null,
    is_tenant_admin: true,
    ...overrides,
  };
}

async function request(path: string, user: DbRow | null, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (user !== null) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { ...init, headers }, TEST_ENV);
}

beforeEach(() => {
  resetDb(() => []);
});

describe("平台运营闸门（main.py:_require_platform_ops）", () => {
  it("无 token → 401", async () => {
    const res = await request("/api/v1/admin/feature_flag", null);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
  });

  it("customer 账号即使 role=system_admin → 403 Platform operator required", async () => {
    const user = userRow({ account_type: "customer", team_id: 7 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/admin/feature_flag", user);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: { error: "forbidden", message: "Platform operator required" },
    });
  });

  it("GET feature_flag → 200，形状为 {租户:{开关:bool}}", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM feature_flags")) {
        return [
          { flag_name: "use_v2", flag_value: true },
          { flag_name: "beta_ui", flag_value: false },
        ];
      }
      return [];
    });

    const res = await request("/api/v1/admin/feature_flag", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ default: { use_v2: true, beta_ui: false } });
  });

  it("显式请求别的租户 → 404 TENANT_NOT_FOUND（单租户部署）", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/admin/feature_flag?tenant_id=other", user);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: { error: "not_found", code: "TENANT_NOT_FOUND" },
    });
  });
});

describe("POST /api/v1/admin/feature_flag", () => {
  it("缺 flag_name（含前端 flag_key 别名也未给）→ 422 detail 字符串", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/admin/feature_flag", user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ detail: "flag_name is required" });
  });
});

describe("账号治理（ws_admin_accounts.py）", () => {
  it("customer 账号 → 403 且错误体只有 error 键（与平台运营闸门不同）", async () => {
    const user = userRow({ account_type: "customer", role: "admin", team_id: 7 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/admin/accounts", user);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: { error: "forbidden" } });
  });

  it("GET accounts → 200，白名单序列化（无 password_hash）", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM users u")) {
        return [{
          id: 1,
          email: "ops@kaas.test",
          display_name: "Ops",
          account_type: "internal",
          role: "admin",
          status: "active",
          team_id: null,
          console_access: true,
          created_at: new Date("2026-09-01T00:00:00Z"),
          updated_at: null,
          team_name: null,
          password_hash: "must-not-leak",
        }];
      }
      if (query.includes("count(*) AS n FROM users")) return [{ n: "1" }];
      return [];
    });

    const res = await request("/api/v1/admin/accounts", user);

    expect(res.status).toBe(200);
    const body = await res.json() as { accounts: DbRow[]; total: number };
    expect(body.total).toBe(1);
    expect(body.accounts[0]).toEqual({
      id: 1,
      email: "ops@kaas.test",
      display_name: "Ops",
      account_type: "internal",
      role: "system_admin",
      status: "active",
      team_id: null,
      team_name: null,
      console_access: true,
      created_at: "2026-09-01T00:00:00.000+00:00",
      updated_at: null,
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("停用自己 → 409 SELF_PROTECT", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM users WHERE id=$1")) return [user];
      return [];
    });

    const res = await request("/api/v1/admin/accounts/1", user, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "disabled" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: { error: "conflict", code: "SELF_PROTECT" } });
  });

  it("非法 status → 422 validation_error", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/admin/accounts/2", user, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "banned" }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: { error: "validation_error", message: "status must be active|disabled" },
    });
  });
});

describe("属性沉淀提案（ws_admin_proposals.py）", () => {
  it("GET 提案列表 → 200 items", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM attribute_proposals")) {
        return [{
          id: 4,
          tenant_id: "default",
          category_id: 2,
          proposed_name: "Wall Thickness",
          proposed_type: "number",
          group_code: null,
          status: "pending",
          occurrence_count: "3",
          recommended_for_promotion: true,
          recommendation_score: "0.75",
          created_at: new Date("2026-10-02T00:00:00Z"),
        }];
      }
      return [];
    });

    const res = await request("/api/v1/admin/spec/attribute-proposals?status=pending", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{
        id: 4,
        tenant_id: "default",
        category_id: 2,
        proposed_name: "Wall Thickness",
        proposed_type: "number",
        group_code: null,
        status: "pending",
        occurrence_count: 3,
        recommended_for_promotion: true,
        recommendation_score: 0.75,
        created_at: "2026-10-02T00:00:00.000+00:00",
      }],
    });
  });

  it("审核不存在的提案 → 200 + {error:not_found}（Python 侧就是 200，不是 404）", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/admin/spec/attribute-proposals/999", user, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
