/**
 * customers 域路由测试（真源 = backend/worker/src/main.py:1368-1708 等）。
 *
 * 重点：列表鉴权（无 token 401）+ 租户过滤（tenant_id='default' 恒为第一个绑定参数）
 * + 非管理员三层可见性（owner_id / owner_scope='tenant' / team_id）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { createToken } from "../src/session";
import {
  FIXED_SECRET,
  makeTestEnv,
  resetDb,
  TEST_ENV,
  dbCallsContaining,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 2,
    email: "member@qa.test",
    display_name: "Member",
    account_type: "customer",
    role: "user",
    status: "active",
    team_id: 7,
    console_access: false,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

const CUSTOMER_ROW: DbRow = {
  id: 1,
  name: "Acme Fence",
  country: "US",
  stage: "inactive",
  stage_display: "ordered",
  created_at: new Date("2026-10-01T00:00:00Z"),
  updated_at: new Date("2026-10-02T00:00:00Z"),
};

async function getCustomers(user: DbRow, token: string): Promise<Response> {
  resetDb((query) => {
    if (query.includes("FROM users WHERE id")) return [user];
    if (query.startsWith("SELECT COUNT(*)")) return [{ count: "1" }];
    if (query.includes("FROM customers c WHERE")) return [CUSTOMER_ROW];
    return [];
  });
  return app.request("/api/v1/customers", {
    headers: { Authorization: `Bearer ${token}` },
  }, TEST_ENV);
}

beforeEach(() => {
  resetDb(() => []);
});

describe("GET /api/v1/customers", () => {
  it("无 token → 401（鉴权先于任何客户查询）", async () => {
    const res = await app.request("/api/v1/customers", {}, TEST_ENV);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
    expect(dbCallsContaining("FROM customers")).toHaveLength(0);
  });

  it("普通成员：tenant_id 恒为 default + 三层可见性条件（owner_id/tenant/team_id）", async () => {
    const user = userRow();
    const token = await createToken(user.id as number, FIXED_SECRET);

    const res = await getCustomers(user, token);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Record<string, unknown>[];
      total: number;
      page: number;
      page_size: number;
    };
    expect(body).toMatchObject({ total: 1, page: 1, page_size: 20 });
    expect(body.items[0]).toMatchObject({
      id: 1,
      company_name: "Acme Fence",
      stage: "ordered", // 展示值由开启中的订单推导
      manual_stage: "inactive", // 手动列仍是 inactive
      created_at: "2026-10-01T00:00:00.000+00:00", // JS Date 精度差异：见 README 语义差异登记
    });

    const total = dbCallsContaining("SELECT COUNT(*)")[0];
    expect(total).toBeDefined();
    // 租户过滤：第一个绑定参数固定 'default'（AGENTS.md：单租户部署，租户恒 default）
    expect(total!.params[0]).toBe("default");
    expect(total!.query).toContain("c.tenant_id = $1");
    expect(total!.query).toContain("c.is_deleted = false");
    // §10.3：非管理员再叠加 owner / tenant / team 可见性
    expect(total!.query).toContain("c.owner_id = $2");
    expect(total!.query).toContain("c.owner_scope = 'tenant'");
    expect(total!.query).toContain("c.team_id = $3");
    expect(total!.params).toEqual(["default", "2", 7]);
  });

  it("管理员：仍然按 tenant_id 过滤，但不叠加 owner/team 可见性（全租户可见）", async () => {
    const user = userRow({ id: 1, role: "system_admin" });
    const token = await createToken(user.id as number, FIXED_SECRET);

    const res = await getCustomers(user, token);
    expect(res.status).toBe(200);

    const total = dbCallsContaining("SELECT COUNT(*)")[0];
    expect(total).toBeDefined();
    expect(total!.params[0]).toBe("default");
    expect(total!.query).toContain("c.tenant_id = $1");
    expect(total!.query).not.toContain("c.owner_id =");
    expect(total!.query).not.toContain("c.team_id =");
    expect(total!.params).toEqual(["default"]);
  });
});

describe("inquiries（M1-f：门面只透传内核，不再有第二份 SQL）", () => {
  interface Forwarded {
    method: string;
    path: string;
    search: string;
    body: string;
    auth: string | null;
  }

  function installUserAndKernel(status = 200, payload: unknown = { items: [], total: 0 }) {
    const seen: Forwarded[] = [];
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));
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

  it("GET /api/v1/inquiries/{id} 无 token → 401 且不触达内核", async () => {
    const { seen, env } = installUserAndKernel();

    const res = await app.request("/api/v1/inquiries/1", {}, env);

    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("GET /api/v1/inquiries 原样转发 M1-d 筛选参数（门面不写第二份 SQL）", async () => {
    const token = await createToken(2, FIXED_SECRET);
    const { seen, env } = installUserAndKernel();
    const search = "?stage=quoted&channel=email&q=acme&date_from=2026-10-01&date_to=2026-10-31";

    const res = await app.request(
      "/api/v1/inquiries" + search,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect(seen[0]!.path).toBe("/api/v1/inquiries");
    expect(seen[0]!.search).toBe(search);
    expect(seen[0]!.auth).toMatch(/^Bearer /);
    // 历史债已清：询盘列表不再由门面查库
    expect(dbCallsContaining("FROM cust_inquiries")).toHaveLength(0);
  });

  it("GET /api/v1/inquiries/{id} 详情透传（报价历史形状由内核给）", async () => {
    const token = await createToken(2, FIXED_SECRET);
    const { seen, env } = installUserAndKernel();

    const res = await app.request(
      "/api/v1/inquiries/42?include_quotes=1",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.path).toBe("/api/v1/inquiries/42");
    expect(seen[0]!.search).toBe("?include_quotes=1");
    expect(dbCallsContaining("FROM cust_inquiries")).toHaveLength(0);
  });

  it("PATCH /api/v1/inquiries/{id} 原样转发 body；内核 409 原样透传", async () => {
    const token = await createToken(2, FIXED_SECRET);
    const { seen, env } = installUserAndKernel(409, {
      detail: { error: "conflict", code: "INQUIRY_NO_LOCKED" },
    });
    const body = { status: "quoted", items: [{ product_name: "A", quantity: 2 }] };

    const res = await app.request(
      "/api/v1/inquiries/42",
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: { error: "conflict", code: "INQUIRY_NO_LOCKED" } });
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.path).toBe("/api/v1/inquiries/42");
    expect(JSON.parse(seen[0]!.body)).toEqual(body);
  });

  it("GET /api/v1/inquiries/{id}/stage-log 原样转发（阶段日志全在内核）", async () => {
    const token = await createToken(2, FIXED_SECRET);
    const { seen, env } = installUserAndKernel();

    const res = await app.request(
      "/api/v1/inquiries/42/stage-log",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect(seen[0]!.path).toBe("/api/v1/inquiries/42/stage-log");
    expect(dbCallsContaining("FROM inquiry_stage_log")).toHaveLength(0);
  });
});
