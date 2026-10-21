/**
 * auth 域路由测试（9 条真源 = backend/worker/src/main.py:295-943）。
 *
 * env 注入：app.request(path, init, TEST_ENV)；DB 用 helpers.resetDb(handler) 按 SQL 片段打桩。
 * 断言口径以 Python 真源为准（含状态码与错误信封逐字段）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { createToken } from "../src/session";
import {
  FIXED_SECRET,
  PYTHON_BCRYPT_HASH,
  resetDb,
  TEST_ENV,
  TEST_PASSWORD,
  dbState,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

async function jsonRequest(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return await app.request(path, { method: "POST", headers, body: JSON.stringify(body) }, TEST_ENV);
}

const LOGIN_ROW = {
  id: 5,
  email: "buyer@qa.test",
  password_hash: PYTHON_BCRYPT_HASH,
  display_name: "Buyer",
  account_type: "customer",
  role: "owner",
  status: "active",
  team_id: 9,
  console_access: true,
  plan: "free",
};

const ME_ROW = {
  id: 5,
  email: "buyer@qa.test",
  display_name: "Buyer",
  account_type: "customer",
  role: "owner",
  status: "active",
  team_id: 9,
  console_access: false,
  plan: null,
  is_tenant_admin: false,
};

beforeEach(() => {
  resetDb(() => []);
});

describe("POST /api/v1/auth/login", () => {
  it("登录成功：扁平 11 键 + plan + bearer token + team_name（main.py:_auth_payload）", async () => {
    resetDb((query) => {
      if (query.includes("FROM users WHERE email=")) return [LOGIN_ROW];
      if (query.includes("FROM teams WHERE id")) return [{ name: "Acme Team" }];
      return [];
    });

    const res = await jsonRequest("/api/v1/auth/login", {
      email: "  Buyer@QA.test  ",
      password: TEST_PASSWORD,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "access_token", "account_type", "console_access", "display_name", "email",
      "plan", "role", "team_id", "team_name", "token_type", "user_id",
    ]);
    expect(body).toMatchObject({
      user_id: 5,
      email: "buyer@qa.test",
      display_name: "Buyer",
      account_type: "customer",
      role: "owner",
      plan: "free",
      team_id: 9,
      team_name: "Acme Team",
      console_access: true,
      token_type: "bearer",
    });
    expect(String(body.access_token).split(".")).toHaveLength(3);
    expect(body).not.toHaveProperty("password_hash");

    // 邮箱 strip + lower 后才查库（main.py:344，PARITY-DIFF-8）
    const lookup = dbState.calls.find((call) => call.query.includes("FROM users WHERE email="));
    expect(lookup?.params[0]).toBe("buyer@qa.test");
  });

  it('密码错误 → 401 {"detail":"Invalid credentials"}（main.py:346）', async () => {
    resetDb((query) => (query.includes("FROM users WHERE email=") ? [LOGIN_ROW] : []));

    const res = await jsonRequest("/api/v1/auth/login", {
      email: "buyer@qa.test",
      password: "wrong-password",
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: "Invalid credentials" });
  });

  it("缺字段 → 422 pydantic 形状（Python 真源 test_parity_auth.py:536；不是 400）", async () => {
    const res = await jsonRequest("/api/v1/auth/login", { email: "buyer@qa.test" });

    expect(res.status).toBe(422);
    expect(res.status).not.toBe(400);
    const body = (await res.json()) as { detail: Array<Record<string, unknown>> };
    expect(Array.isArray(body.detail)).toBe(true);
    expect(body.detail[0]).toMatchObject({
      type: "missing",
      loc: ["body", "password"],
      msg: "Field required",
    });
  });

  it("账号禁用（密码正确）→ 403 forbidden: Account is disabled（PARITY-DIFF-7）", async () => {
    resetDb((query) => (
      query.includes("FROM users WHERE email=") ? [{ ...LOGIN_ROW, status: "disabled" }] : []
    ));

    const res = await jsonRequest("/api/v1/auth/login", {
      email: "buyer@qa.test",
      password: TEST_PASSWORD,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: "forbidden: Account is disabled" });
  });
});

describe("GET /api/v1/auth/me", () => {
  it("带 token → 扁平 profile（user_id/effective_role/tenant_id/team_name）", async () => {
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [ME_ROW];
      if (query.includes("FROM teams WHERE id")) return [{ name: "Acme Team" }];
      return [];
    });
    const token = await createToken(ME_ROW.id, FIXED_SECRET);

    const res = await app.request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 5,
      user_id: 5,
      email: "buyer@qa.test",
      team_id: 9,
      team_name: "Acme Team",
      plan: "free",
      effective_role: "customer_owner", // owner → customer_owner（scope.py:_ROLE_MAP）
      tenant_id: "default",
      status: "active",
    });
  });

  it('无 token → 401 {"error":"unauthorized","message":"Authentication required"}', async () => {
    const res = await app.request("/api/v1/auth/me", {}, TEST_ENV);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
    expect(dbState.calls).toHaveLength(0);
  });

  it("坏 token → 401 Invalid or expired token（不查库）", async () => {
    const res = await app.request("/api/v1/auth/me", {
      headers: { Authorization: "Bearer not.a.jwt" },
    }, TEST_ENV);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Invalid or expired token" },
    });
    expect(dbState.calls).toHaveLength(0);
  });
});
