/**
 * W5 M3 · API token 路径 → scope 映射与全局闸门测试。
 *
 * 覆盖：
 * - 有序规则命中（读/写方法、具体前缀优先、未命中 = null）；
 * - 规则只使用 tokens.ts 白名单 scope（不发明 scope）；
 * - 全局中间件：合法 token 通过、缺 scope 403、未声明路径 403、无效 token 401；
 * - JWT 语义零改动（非 kaas_oat_ 不查 api_tokens）；
 * - 管理端点 /api/v1/api-tokens 保持 JWT-only（不查 token 表，防自举提权）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { createToken } from "../src/session";
import { API_TOKEN_SCOPES, mintApiToken } from "../src/tokens";
import { isValidScopeRule, resolveRequiredScope, SCOPE_RULES } from "../src/scope-map";
import {
  dbCallsContaining,
  FIXED_SECRET,
  resetDb,
  TEST_ENV,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

function tokenRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 3,
    tenant_id: "default",
    team_id: 4,
    name: "CI token",
    scopes: ["customers:read"],
    prefix: "kaas_oat_AbCdEf12",
    created_by: 5,
    created_at: new Date("2026-10-21T03:00:00Z"),
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 5,
    email: "owner@qa.test",
    display_name: "Owner",
    account_type: "customer",
    role: "owner",
    status: "active",
    team_id: 4,
    console_access: false,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

function installToken(scopes: string[], overrides: Partial<DbRow> = {}): string {
  const minted = mintApiToken();
  resetDb((query) => {
    if (query.includes("FROM api_tokens")) return [tokenRow({ scopes, ...overrides })];
    if (query.includes("FROM users WHERE id")) return [userRow()];
    return [];
  });
  return minted.plaintext;
}

function bearer(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

beforeEach(() => {
  resetDb(() => []);
});

// ── 纯映射 ────────────────────────────────────────────────────────────────

describe("resolveRequiredScope（有序规则）", () => {
  const cases: Array<[string, string, string | null]> = [
    ["GET", "/api/v1/customers", "customers:read"],
    ["POST", "/api/v1/customers", "customers:write"],
    ["GET", "/api/v1/customers/123/inquiries", "customers:read"],
    ["GET", "/api/v1/inquiries", "inquiries:read"],
    ["PATCH", "/api/v1/inquiries/1", "inquiries:write"],
    ["GET", "/api/v1/orders/1", "orders:read"],
    // 任务口径：orders/shipments 同属订单域，用 orders:*。
    ["POST", "/api/v1/shipments", "orders:write"],
    ["GET", "/api/v1/receivables", "orders:read"],
    // 报价：具体 calculate* 必须先于 export-quote 泛前缀。
    ["POST", "/api/v1/export-quote/calculate", "quotes:calc"],
    ["POST", "/api/v1/export-quote/calculate-internal", "quotes:calc"],
    ["POST", "/api/v1/export-quote/verify", "quotes:calc"],
    ["POST", "/api/v1/export-quote/import/calculate", "quotes:calc"],
    ["GET", "/api/v1/export-quote/products", "quotes:read"],
    ["GET", "/api/v1/quotes/1", "quotes:read"],
    ["POST", "/api/v1/quotes", "quotes:calc"],
    ["GET", "/api/v1/quotations", "quotes:read"],
    ["GET", "/api/v1/trade-docs", "trade_docs:read"],
    ["DELETE", "/api/v1/file-objects/1", "files:write"],
    ["GET", "/api/v1/files/1/content", "files:read"],
    ["GET", "/api/v1/leadgen/runs", "leadgen:read"],
    ["GET", "/api/v1/leads", "leadgen:read"],
    ["GET", "/api/v1/research/products", "research:read"],
    ["GET", "/api/v1/intel/shipments", "intel:read"],
    ["GET", "/api/v1/market/regions", "intel:read"],
    ["GET", "/api/v1/outreach/messages", "outreach:read"],
    // M1-e：审批中心 / 站内通知复用 orders:*（审批链路同域）；指定审批人故意未声明。
    ["GET", "/api/v1/approvals", "orders:read"],
    ["GET", "/api/v1/notifications", "orders:read"],
    ["GET", "/api/v1/notifications/unread-count", "orders:read"],
    ["POST", "/api/v1/notifications/read-all", "orders:write"],
    ["GET", "/api/v1/team/approvers", null],
    // P0-A A3：dashboard 只读聚合复用 orders:read（白名单无 dashboard:read）。
    ["GET", "/api/v1/dashboard/receivables", "orders:read"],
    ["GET", "/api/v1/dashboard/funnel", "orders:read"],
    // 只读域：写方法未声明 ⇒ 403（readOnly 只登记 GET/HEAD/OPTIONS）
    ["POST", "/api/v1/dashboard/receivables", null],
    // 未声明 → null（调用方必须 403）
    ["POST", "/api/v1/intel/shipments", null],
    ["POST", "/api/v1/market/name-mappings", null],
    ["GET", "/api/v1/admin/feature_flag", null],
    ["GET", "/api/v1/api-tokens", null],
    ["GET", "/api/v1/enums", null],
    ["GET", "/health", null],
    ["GET", "/mcp", null],
  ];

  for (const [method, path, expected] of cases) {
    it(`${method} ${path} → ${expected ?? "未声明"}`, () => {
      expect(resolveRequiredScope(method, path)?.scope ?? null).toBe(expected);
    });
  }

  it("规则只使用 API_TOKEN_SCOPES 白名单（不发明 scope）", () => {
    const invalid = SCOPE_RULES.filter((rule) => !isValidScopeRule(rule));
    expect(invalid).toEqual([]);
    for (const rule of SCOPE_RULES) {
      expect(API_TOKEN_SCOPES).toContain(rule.scope);
    }
  });

  it("路径前缀按段匹配，不做字符串前缀误伤", () => {
    expect(resolveRequiredScope("GET", "/api/v1/customersX")).toBeNull();
    expect(resolveRequiredScope("GET", "/api/v1/customer/9/capabilities")?.scope).toBe(
      "customers:read",
    );
  });
});

// ── 全局中间件 ────────────────────────────────────────────────────────────

describe("apiTokenScopeMiddleware（全局 /api/* 闸门）", () => {
  it("token 有对应 read scope → 业务路由正常执行", async () => {
    const token = installToken(["customers:read"]);
    const res = await app.request("/api/v1/customers", bearer(token), TEST_ENV);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    // token 创建人装载（TS 路由用 token.created_by / team_id）
    expect(dbCallsContaining("FROM users WHERE id")[0]?.params).toEqual([5]);
  });

  it("token 缺 write scope → 403 SCOPE_NOT_DECLARED（不进入业务查询）", async () => {
    const token = installToken(["customers:read"]);
    const res = await app.request(
      "/api/v1/customers",
      bearer(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company_name: "X" }),
      }),
      TEST_ENV,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { code: string; message: string } };
    expect(body.detail.code).toBe("SCOPE_NOT_DECLARED");
    expect(body.detail.message).toContain("customers:write");
  });

  it("未声明路径（/api/v1/admin/*）→ 403 SCOPE_NOT_DECLARED", async () => {
    const token = installToken(["customers:read"]);
    const res = await app.request("/api/v1/admin/feature_flag", bearer(token), TEST_ENV);

    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { code: string } };
    expect(body.detail.code).toBe("SCOPE_NOT_DECLARED");
  });

  it("无效/撤销/过期 token → 401（与现有 unauthorized 信封一致）", async () => {
    resetDb(() => []);
    const token = mintApiToken().plaintext;
    const res = await app.request("/api/v1/customers", bearer(token), TEST_ENV);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Invalid or expired token" },
    });
  });

  it("JWT 请求完全走原路径：不查 api_tokens", async () => {
    resetDb((query) => (query.includes("FROM users WHERE id") ? [userRow()] : []));
    const jwt = await createToken(5, FIXED_SECRET);
    const res = await app.request("/api/v1/customers", bearer(jwt), TEST_ENV);

    expect(res.status).toBe(200);
    expect(dbCallsContaining("FROM api_tokens")).toHaveLength(0);
  });

  it("非 /api 路径（/health）不被 token 闸门拦截", async () => {
    const token = installToken(["customers:read"]);
    const res = await app.request("/health", bearer(token), TEST_ENV);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "kaas-edge" });
    expect(dbCallsContaining("FROM api_tokens")).toHaveLength(0);
  });

  it("管理端点 /api/v1/api-tokens 保持 JWT-only：kaas_oat_ 401 且不查 token 表", async () => {
    resetDb((query) => (query.includes("FROM api_tokens") ? [tokenRow()] : []));
    const token = mintApiToken().plaintext;
    const res = await app.request("/api/v1/api-tokens", bearer(token), TEST_ENV);

    expect(res.status).toBe(401);
    expect(dbCallsContaining("FROM api_tokens")).toHaveLength(0);
  });
});
