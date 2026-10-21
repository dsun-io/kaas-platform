/**
 * workstations 域路由测试（真源 = backend/worker/src/ws_workstations.py /
 * ws_enums.py / ws_products.py / main.py:2552-2667,4833-4911）。
 *
 * 重点：
 * - /enums 与 Python 一致**不鉴权**（静态字典，前端登录前后都用）；
 * - /me/workstations 生效编码 = 团队 ∪ 个人（平台管理员 = full_chain）；
 * - 个人工位开通仅平台管理员（403 ADMIN_ONLY）；未知工位 422 UNKNOWN_WORKSTATION；
 * - 企业抬头的团队管理员闸门与 name_en 必填（422 先于 403）。
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import workstationsRoutes from "../src/routes/workstations";
import { createToken } from "../src/session";
import {
  FIXED_SECRET,
  resetDb,
  TEST_ENV,
  dbState,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

const app = new Hono();
app.route("/", workstationsRoutes);

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 7,
    email: "ws@qa.test",
    display_name: "WS User",
    account_type: "customer",
    role: "owner",
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
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (user) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { ...init, headers }, TEST_ENV);
}

function putJson(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  resetDb(() => []);
});

describe("GET /api/v1/enums", () => {
  it("无 token 也返回完整字典（与 Python 一致不鉴权）", async () => {
    const res = await request("/api/v1/enums", null);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string[]>;
    expect(Object.keys(body)).toEqual([
      "inquiry_status", "customer_stage", "quote_status", "order_status",
      "shipment_status", "inquiry_channel", "doc_type", "doc_status",
      "currency", "owner_scope", "schedule_type", "schedule_status",
      "receivable_status", "bl_type",
    ]);
    expect(body.doc_type).toHaveLength(23);
    expect(body.currency).toEqual(["USD", "CNY", "EUR", "GBP", "JPY", "AUD", "CAD", "HKD"]);
  });
});

describe("GET /api/v1/me/workstations（ws_workstations.py:123-137）", () => {
  it("平台管理员 → 全部工位 + codes=[full_chain]", async () => {
    const user = userRow({ role: "system_admin", account_type: "internal" });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/me/workstations", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workstations: [
        "customers", "intel", "leadgen", "orders", "outreach",
        "quotes", "research", "shipments", "trade-docs",
      ],
      codes: ["full_chain"],
      is_admin: true,
      has_team: true,
    });
    // 管理员跳过订阅查询（Python _codes_for_user 直接返回 full_chain）
    expect(dbState.calls.some((call) => call.query.includes("team_subscriptions"))).toBe(false);
  });

  it("普通成员 → 团队 ∪ 个人生效编码（去重、排序、未知码透传）", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM team_subscriptions")) return [{ code: "quotes" }];
      if (query.includes("FROM user_subscriptions")) return [{ code: "leadgen" }, { code: " Quotes " }];
      return [];
    });

    const res = await request("/api/v1/me/workstations", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workstations: ["leadgen", "quotes"],
      codes: ["leadgen", "quotes"],
      is_admin: false,
      has_team: true,
    });
  });
});

describe("个人工位订阅（仅平台管理员）", () => {
  it("普通账号 GET → 403 ADMIN_ONLY（闸门先于取数）", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/users/9/subscriptions", user);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: {
        error: "forbidden", code: "ADMIN_ONLY",
        message: "个人工位开通仅平台管理员可操作",
      },
    });
    expect(dbState.calls.some((call) => call.query.includes("FROM user_subscriptions"))).toBe(false);
  });

  it("管理员 PUT 未知工位 → 422 UNKNOWN_WORKSTATION（文案逐字对齐）", async () => {
    const user = userRow({ role: "system_admin", account_type: "internal" });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request(
      "/api/v1/users/9/subscriptions/not_a_workstation",
      user,
      putJson({ active: true }),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: Record<string, unknown> };
    expect(body.detail.error).toBe("validation");
    expect(body.detail.code).toBe("UNKNOWN_WORKSTATION");
    expect(String(body.detail.detail)).toContain("未知工位：not_a_workstation；可选：");
  });
});

describe("企业抬头（main.py:4833-4911）", () => {
  it("PUT 缺 name_en → 422 NAME_EN_REQUIRED（校验先于权限）", async () => {
    const user = userRow({ team_id: null });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/tenant/company-profile", user, putJson({ phone: "1" }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "validation", code: "NAME_EN_REQUIRED",
        detail: "英文公司名必填（对外单据的卖方主体名）",
      },
    });
    expect(dbState.calls.some((call) => call.query.includes("FROM teams WHERE id"))).toBe(false);
  });

  it("PUT 有 name_en 但无团队 → 403 TEAM_ADMIN_REQUIRED", async () => {
    const user = userRow({ team_id: null });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request(
      "/api/v1/tenant/company-profile",
      user,
      putJson({ name_en: "Acme Trading Co." }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: {
        error: "forbidden", code: "TEAM_ADMIN_REQUIRED",
        detail: "仅团队管理员可修改企业抬头/收款信息/公章",
      },
    });
  });

  it("GET 无记录时返回全 null + configured=false", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/tenant/company-profile", user);

    expect(res.status).toBe(200);
    const body = (await res.json()) as DbRow;
    expect(body.name_en).toBeNull();
    expect(body.swift_code).toBeNull();
    expect(body.configured).toBe(false);
    expect(Object.keys(body)).toHaveLength(15);
  });
});
