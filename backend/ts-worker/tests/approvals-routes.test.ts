/**
 * approvals 域（M1-e）显式路由测试：审批中心 / 站内通知 / 指定审批人 / 订单明细变更申请。
 *
 * 口径（ADR-008 铁纪律）：门面只做鉴权 + 原样透传，审批路由/自批判定/通知语义全在 Python 内核。
 * 覆盖：
 * - 无 token / 坏 token → 401，且不触达内核；
 * - 10 条路由逐条原样转发（method / path / query / body / Authorization 头）；
 *   `GET /notifications/unread-count` 自 2026-10-24 P0 起由 src/routes/notifications.ts 注册
 *   （开关 on 直连 DB、off 仍透传），其透传/直连行为见 tests/p0-hot-reads.test.ts；
 * - 内核 4xx 原样透传、5xx 归一 kernel_error；
 * - API token 身份 → 铸短时效内部 JWT（绝不透传 kaas_oat_ 明文）+ 无 scope 403。
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyToken } from "../src/auth";
import approvalsRoutes from "../src/routes/approvals";
import { apiTokenScopeMiddleware } from "../src/scope-map";
import { createToken } from "../src/session";
import { mintApiToken } from "../src/tokens";
import {
  FIXED_SECRET,
  makeTestEnv,
  resetDb,
  TEST_ENV,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

const app = new Hono();
app.route("/", approvalsRoutes);

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 9,
    email: "approver@qa.test",
    display_name: "Approver",
    account_type: "internal",
    role: "sales",
    status: "active",
    team_id: 4,
    console_access: false,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

function tokenRow(scopes: string[], overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 3,
    tenant_id: "default",
    team_id: 4,
    name: "CI token",
    scopes,
    prefix: "kaas_oat_AbCdEf12",
    created_by: 5,
    created_at: new Date("2026-10-21T03:00:00Z"),
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

async function request(
  path: string,
  init: RequestInit = {},
  env: typeof TEST_ENV = TEST_ENV,
  token?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return app.request(path, { ...init, headers }, env);
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function installUser(user: DbRow): void {
  resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));
}

/** mock KERNEL：记录实际转发内容，返回固定 JSON。 */
function kernelRecorder(status = 200, payload: unknown = { ok: true }) {
  const seen: Array<{
    method: string;
    path: string;
    search: string;
    body: string;
    auth: string | null;
  }> = [];
  const env = makeTestEnv({
    KERNEL: {
      fetch: async (input: Request) => {
        const url = new URL(input.url);
        seen.push({
          method: input.method,
          path: url.pathname,
          search: url.search,
          body: await input.text(),
          auth: input.headers.get("authorization"),
        });
        return new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  return { seen, env };
}

beforeEach(() => {
  resetDb(() => []);
});

describe("审批/通知路由：门面鉴权（401 且不触达内核）", () => {
  it("GET /api/v1/approvals 无 token → 401", async () => {
    const { seen, env } = kernelRecorder();
    const res = await request("/api/v1/approvals", {}, env);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
    expect(seen).toHaveLength(0);
  });

  it("POST /api/v1/notifications/read-all 坏 token → 401", async () => {
    const { seen, env } = kernelRecorder();
    const res = await request(
      "/api/v1/notifications/read-all",
      { method: "POST" },
      env,
      "not-a-jwt",
    );

    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

describe("逐条显式路由原样透传（method / path / query / body）", () => {
  const cases: Array<{ method: string; path: string; body?: unknown }> = [
    {
      method: "POST",
      path: "/api/v1/orders/31/item-change-requests",
      body: { items: [{ product_name: "A", quantity: 2 }] },
    },
    { method: "GET", path: "/api/v1/orders/31/item-change-requests" },
    {
      method: "POST",
      path: "/api/v1/orders/31/item-change-requests/7/approve",
      body: { comment: "ok" },
    },
    {
      method: "POST",
      path: "/api/v1/orders/31/item-change-requests/7/reject",
      body: { reason: "明细不符" },
    },
    { method: "GET", path: "/api/v1/approvals?view=pending&page=2" },
    { method: "GET", path: "/api/v1/notifications?unread=1" },
    { method: "POST", path: "/api/v1/notifications/5/read" },
    { method: "POST", path: "/api/v1/notifications/read-all" },
    { method: "GET", path: "/api/v1/team/approvers" },
    { method: "PUT", path: "/api/v1/team/approvers", body: { user_ids: [1, 2] } },
  ];

  for (const item of cases) {
    it(`${item.method} ${item.path.split("?")[0]} → 原样转发内核`, async () => {
      const token = await createToken(9, FIXED_SECRET);
      installUser(userRow());
      const { seen, env } = kernelRecorder();
      const init = item.body === undefined ? { method: item.method } : jsonInit(item.method, item.body);
      const res = await request(item.path, init, env, token);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(seen).toHaveLength(1);
      const [path, search] = item.path.split("?");
      expect(seen[0]!.method).toBe(item.method);
      expect(seen[0]!.path).toBe(path);
      expect(seen[0]!.search).toBe(search ? "?" + search : "");
      // 会话 JWT 原样带过去（内核 _get_current_user 用同一 secret 校验）
      expect(seen[0]!.auth).toMatch(/^Bearer /);
      if (item.body === undefined) {
        expect(seen[0]!.body).toBe("");
      } else {
        expect(JSON.parse(seen[0]!.body)).toEqual(item.body);
      }
    });
  }
});

describe("内核错误信封（门面不改写业务错误）", () => {
  it("内核 409 → 原样透传 detail（不吞错、不改形状）", async () => {
    const token = await createToken(9, FIXED_SECRET);
    installUser(userRow());
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () =>
          new Response(
            JSON.stringify({ detail: { error: "conflict", code: "ALREADY_DECIDED" } }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      },
    });

    const res = await request(
      "/api/v1/orders/31/item-change-requests/7/approve",
      jsonInit("POST", {}),
      env,
      token,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: { error: "conflict", code: "ALREADY_DECIDED" } });
  });

  it("内核 5xx → 502 kernel_error（统一形状）", async () => {
    const token = await createToken(9, FIXED_SECRET);
    installUser(userRow());
    const env = makeTestEnv({
      KERNEL: { fetch: async () => new Response("boom", { status: 502 }) },
    });

    const res = await request("/api/v1/notifications", {}, env, token);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "kernel_error",
      message: "boom",
      status: 502,
    });
  });
});

describe("API token 身份：铸内部 JWT（不透传 kaas_oat_ 明文）", () => {
  const tokenApp = new Hono();
  tokenApp.use("*", apiTokenScopeMiddleware);
  tokenApp.route("/", approvalsRoutes);

  it("orders:read token → GET /api/v1/approvals 200，Authorization 换成内部 JWT（sub=created_by）", async () => {
    const minted = mintApiToken();
    let seenAuth: string | null = null;
    resetDb((query) => {
      if (query.includes("FROM api_tokens")) return [tokenRow(["orders:read"])];
      if (query.includes("FROM users WHERE id")) return [userRow({ id: 5 })];
      return [];
    });
    const env = makeTestEnv({
      KERNEL: {
        fetch: async (input: Request) => {
          seenAuth = input.headers.get("authorization");
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });

    const res = await tokenApp.request(
      "/api/v1/approvals",
      { headers: { Authorization: `Bearer ${minted.plaintext}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect(seenAuth).toMatch(/^Bearer /);
    expect(seenAuth).not.toContain("kaas_oat_");
    const payload = await verifyToken(seenAuth!.slice("Bearer ".length), FIXED_SECRET);
    expect(payload.sub).toBe("5");
  });

  it("缺 scope（customers:read）→ 403 SCOPE_NOT_DECLARED，不触达内核", async () => {
    const minted = mintApiToken();
    let called = false;
    resetDb((query) => {
      if (query.includes("FROM api_tokens")) return [tokenRow(["customers:read"])];
      if (query.includes("FROM users WHERE id")) return [userRow()];
      return [];
    });
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () => {
          called = true;
          return new Response("{}", { status: 200 });
        },
      },
    });

    const res = await tokenApp.request(
      "/api/v1/approvals",
      { headers: { Authorization: `Bearer ${minted.plaintext}` } },
      env,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { code: string; message: string } };
    expect(body.detail.code).toBe("SCOPE_NOT_DECLARED");
    expect(body.detail.message).toContain("orders:read");
    expect(called).toBe(false);
  });

  it("team/approvers 未声明 scope → 403（团队配置只走 UI 会话，不发明新 scope）", async () => {
    const minted = mintApiToken();
    resetDb((query) => {
      if (query.includes("FROM api_tokens")) return [tokenRow(["orders:write"])];
      if (query.includes("FROM users WHERE id")) return [userRow()];
      return [];
    });

    const res = await tokenApp.request(
      "/api/v1/team/approvers",
      { headers: { Authorization: `Bearer ${minted.plaintext}` } },
      TEST_ENV,
    );

    expect(res.status).toBe(403);
  });
});
