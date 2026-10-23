/**
 * imports 域（C29）显式路由测试：历史订单批量导入两条透传。
 *
 * 口径（ADR-008 铁纪律）：门面只做鉴权 + 原样透传；
 * - multipart（file + customer_id）**不解析、不重写** —— Content-Type/boundary 与原始
 *   字节原样到内核（CSV 校验/事务/撞库判定全在 Python 内核）；
 * - 4xx 原样透传（422 IMPORT_HAS_ERRORS / 409 IMPORT_DUPLICATE_ORDER_NO 信封不改写）；
 * - 5xx 归一 kernel_error；
 * - 坏 JWT 门面 401（不打到内核）；匿名交给内核裁决（与 Python 端点一致）；
 * - API token 未声明 scope ⇒ 403 SCOPE_NOT_DECLARED（设计 §1-9 有意，批量写入不开给 token）。
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import importsRoutes from "../src/routes/imports";
import { apiTokenScopeMiddleware } from "../src/scope-map";
import { createToken } from "../src/session";
import { mintApiToken } from "../src/tokens";
import { FIXED_SECRET, makeTestEnv, resetDb, TEST_ENV, type DbRow } from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

const app = new Hono();
app.route("/", importsRoutes);

const PREVIEW = "/api/v1/imports/orders/preview";
const COMMIT = "/api/v1/imports/orders";

const CSV = "order_no,order_date\nSO-001,2026-05-01\n";

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 9,
    email: "importer@qa.test",
    display_name: "Importer",
    account_type: "internal",
    role: "member",
    status: "active",
    team_id: 4,
    console_access: false,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

function tokenRow(scopes: string[]): DbRow {
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
  };
}

function multipartInit(): RequestInit {
  const form = new FormData();
  form.append("file", new File([CSV], "orders.csv", { type: "text/csv" }));
  form.append("customer_id", "7");
  return { method: "POST", body: form };
}

/** mock KERNEL：记录实际转发内容（含 multipart 原始体），返回固定响应。 */
function kernelRecorder(status = 200, payload: unknown = { ok: true }) {
  const seen: Array<{
    method: string;
    path: string;
    contentType: string | null;
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
          contentType: input.headers.get("content-type"),
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

describe("imports 路由：multipart 原样透传（门面不解析不重写）", () => {
  it("POST /imports/orders/preview：path/method/Content-Type/字节原样到内核", async () => {
    const token = await createToken(9, FIXED_SECRET);
    resetDb((query) => (query.includes("FROM users WHERE id") ? [userRow()] : []));
    const { seen, env } = kernelRecorder(200, {
      customer: { id: 7, name: "ACME" },
      columns: ["order_no", "order_date"],
      rows: [],
      summary: { total: 0, ok: 0, error: 0, existing_order_nos: [] },
    });

    const res = await app.request(
      PREVIEW,
      { ...multipartInit(), headers: { Authorization: "Bearer " + token } },
      env,
    );

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.path).toBe(PREVIEW);
    // multipart 头（含 boundary）不被拆改；body 里 CSV 与字段名原样
    expect(seen[0]!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0]!.body).toContain('name="file"');
    expect(seen[0]!.body).toContain('filename="orders.csv"');
    expect(seen[0]!.body).toContain("order_no,order_date");
    expect(seen[0]!.body).toContain("SO-001,2026-05-01");
    expect(seen[0]!.body).toContain('name="customer_id"');
    // 会话 JWT 原样带过去（内核 _get_current_user 同一 secret 校验）
    expect(seen[0]!.auth).toBe("Bearer " + token);
  });

  it("POST /imports/orders：201 原样透传（created/ids/order_nos 不改写）", async () => {
    const token = await createToken(9, FIXED_SECRET);
    resetDb((query) => (query.includes("FROM users WHERE id") ? [userRow()] : []));
    const { seen, env } = kernelRecorder(201, {
      created: 1,
      ids: [901],
      order_nos: ["SO-001"],
    });

    const res = await app.request(
      COMMIT,
      { ...multipartInit(), headers: { Authorization: "Bearer " + token } },
      env,
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: 1, ids: [901], order_nos: ["SO-001"] });
    expect(seen[0]!.path).toBe(COMMIT);
  });
});

describe("imports 路由：错误信封与鉴权", () => {
  it("内核 422 IMPORT_HAS_ERRORS → 原样透传（嵌套 detail 不改形状）", async () => {
    const token = await createToken(9, FIXED_SECRET);
    resetDb((query) => (query.includes("FROM users WHERE id") ? [userRow()] : []));
    const payload = {
      detail: {
        error: "validation",
        code: "IMPORT_HAS_ERRORS",
        rows: [{ index: 2, errors: ["order_date 不是合法日期（YYYY-MM-DD）"] }],
      },
    };
    const { env } = kernelRecorder(422, payload);

    const res = await app.request(
      COMMIT,
      { ...multipartInit(), headers: { Authorization: "Bearer " + token } },
      env,
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(payload);
  });

  it("内核 409 IMPORT_DUPLICATE_ORDER_NO → 原样透传 order_nos", async () => {
    const token = await createToken(9, FIXED_SECRET);
    resetDb((query) => (query.includes("FROM users WHERE id") ? [userRow()] : []));
    const payload = {
      detail: {
        error: "conflict",
        code: "IMPORT_DUPLICATE_ORDER_NO",
        order_nos: ["SO-009"],
      },
    };
    const { env } = kernelRecorder(409, payload);

    const res = await app.request(
      COMMIT,
      { ...multipartInit(), headers: { Authorization: "Bearer " + token } },
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(payload);
  });

  it("坏 JWT → 门面 401，不触达内核", async () => {
    const { seen, env } = kernelRecorder();
    const res = await app.request(
      PREVIEW,
      { ...multipartInit(), headers: { Authorization: "Bearer not-a-jwt" } },
      env,
    );
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("匿名请求交给内核裁决（401 原样回，不在门面另造信封）", async () => {
    const payload = { detail: "Not authenticated" };
    const { seen, env } = kernelRecorder(401, payload);
    const res = await app.request(PREVIEW, multipartInit(), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(payload);
    expect(seen).toHaveLength(1);
  });

  it("内核 5xx → 502 kernel_error（统一形状）", async () => {
    const token = await createToken(9, FIXED_SECRET);
    resetDb((query) => (query.includes("FROM users WHERE id") ? [userRow()] : []));
    const env = makeTestEnv({
      KERNEL: { fetch: async () => new Response("boom", { status: 502 }) },
    });
    const res = await app.request(
      COMMIT,
      { ...multipartInit(), headers: { Authorization: "Bearer " + token } },
      env,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "kernel_error",
      message: "boom",
      status: 502,
    });
  });

  it("API token 未声明 /imports scope → 403 SCOPE_NOT_DECLARED（有意）", async () => {
    const tokenApp = new Hono();
    tokenApp.use("*", apiTokenScopeMiddleware);
    tokenApp.route("/", importsRoutes);

    const minted = mintApiToken();
    let kernelCalled = false;
    resetDb((query) => {
      if (query.includes("FROM api_tokens")) return [tokenRow(["orders:write"])];
      if (query.includes("FROM users WHERE id")) return [userRow({ id: 5 })];
      return [];
    });
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () => {
          kernelCalled = true;
          return new Response("{}", { status: 200 });
        },
      },
    });

    const res = await tokenApp.request(
      COMMIT,
      { ...multipartInit(), headers: { Authorization: "Bearer " + minted.plaintext } },
      env,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { code: string; message: string } };
    expect(body.detail.code).toBe("SCOPE_NOT_DECLARED");
    expect(body.detail.message).toContain("scope not declared");
    expect(kernelCalled).toBe(false);
  });
});
