/**
 * outreach 域路由测试（真源 = backend/worker/src/chain.py:1682-1993）。
 *
 * 重点：
 * - 无 token → 401；
 * - 工位订阅闸门 → 404 SUBSCRIPTION_REQUIRED（Python 用 404，不是 403）；
 * - 邮箱列表成功形状（api_key 只出掩码 / has_own_key）；
 * - 邮箱重名 → 409 DUPLICATE_MAILBOX；
 * - Inbound webhook 预留桩 → 501 INBOUND_WEBHOOK_RESERVED。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { createToken } from "../src/session";
import { FIXED_SECRET, resetDb, TEST_ENV, type DbRow } from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 5,
    email: "owner@qa.test",
    display_name: "Owner",
    account_type: "customer",
    role: "owner",
    status: "active",
    team_id: 7,
    console_access: false,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

const MAILBOX_ROW: DbRow = {
  id: 3,
  tenant_id: "default",
  email: "sales@kaas.test",
  name: "Sales",
  provider: "resend",
  api_key: "re_1234567890abcdef",
  is_default: true,
  daily_limit: 200,
  sent_today: 4,
  last_sent_date: new Date("2026-10-20T00:00:00Z"),
  enabled: true,
};

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

describe("auth / 订阅闸门", () => {
  it("无 token → 401", async () => {
    const res = await request("/api/v1/outreach/mailboxes", null);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
  });

  it("无 outreach 订阅 → 404 SUBSCRIPTION_REQUIRED（带 workstation/codes）", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/outreach/mailboxes", user);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: {
        error: "subscription_required",
        code: "SUBSCRIPTION_REQUIRED",
        workstation: "outreach",
        codes: ["outreach_starter", "outreach_pro", "full_chain"],
      },
    });
  });
});

describe("GET /api/v1/outreach/mailboxes", () => {
  it("有订阅 → 200，api_key 只出掩码", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM tenant_subscriptions")) return [{ "?column?": 1 }];
      if (query.includes("FROM outreach_mailboxes")) return [MAILBOX_ROW];
      return [];
    });

    const res = await request("/api/v1/outreach/mailboxes", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{
        id: 3,
        email: "sales@kaas.test",
        name: "Sales",
        provider: "resend",
        api_key_masked: "re_1****cdef",
        has_own_key: true,
        is_default: true,
        daily_limit: 200,
        sent_today: 4,
        last_sent_date: "2026-10-20T00:00:00.000+00:00",
        enabled: true,
      }],
      total: 1,
    });
  });
});

describe("POST /api/v1/outreach/mailboxes", () => {
  it("邮箱已存在 → 409 DUPLICATE_MAILBOX", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM tenant_subscriptions")) return [{ "?column?": 1 }];
      if (query.includes("SELECT id FROM outreach_mailboxes")) return [{ id: 9 }];
      return [];
    });

    const res = await request("/api/v1/outreach/mailboxes", user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "sales@kaas.test", name: "Sales" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      detail: { error: "conflict", code: "DUPLICATE_MAILBOX" },
    });
  });

  it("body 缺 email → 422（pydantic 校验失败的 detail 数组）", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/outreach/mailboxes", user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sales" }),
    });

    expect(res.status).toBe(422);
    const body = await res.json() as { detail: DbRow[] };
    expect(Array.isArray(body.detail)).toBe(true);
    expect(body.detail[0]).toMatchObject({ type: "missing", loc: ["body", "email"] });
  });
});

describe("POST /api/v1/outreach/webhook", () => {
  it("预留桩恒 501 INBOUND_WEBHOOK_RESERVED（无 token 也要先过鉴权吗？—— Python 侧无鉴权）", async () => {
    const res = await app.request("/api/v1/outreach/webhook", { method: "POST" }, TEST_ENV);

    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      detail: {
        error: "not_implemented",
        code: "INBOUND_WEBHOOK_RESERVED",
        detail: "Inbound webhook reserved — manual scan available via POST /api/v1/leads/scan-replied",
      },
    });
  });
});
