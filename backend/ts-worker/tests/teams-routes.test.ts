/**
 * teams 域路由测试（真源 = backend/worker/src/ws_teams.py + ws_workstations.py:140-218）。
 *
 * 重点：
 * - GET /api/v1/teams 平台运营闸门（internal 账号 + 管理员角色，缺一不可）→ 403；
 * - 团队管理员闸门（非创建者/非平台管理员）→ 403 NOT_TEAM_ADMIN；
 * - 建团队默认开通全部工位 / 显式勾选只开通所选（不传 ≠ 空数组）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { createToken } from "../src/session";
import {
  FIXED_SECRET,
  resetDb,
  TEST_ENV,
  dbCallsContaining,
  dbState,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

const ALL_WORKSTATIONS = [
  "customers", "intel", "leadgen", "orders", "outreach",
  "quotes", "research", "shipments", "trade-docs",
];

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 5,
    email: "owner@qa.test",
    display_name: "Owner",
    account_type: "customer",
    role: "owner",
    status: "active",
    team_id: null,
    console_access: false,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

const TEAM_ROW: DbRow = { id: 11, name: "Acme Team", created_by: 5 };

async function request(
  path: string,
  user: DbRow,
  init: RequestInit = {},
): Promise<Response> {
  const token = await createToken(user.id as number, FIXED_SECRET);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return app.request(path, { ...init, headers }, TEST_ENV);
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

describe("GET /api/v1/teams（平台运营视图）", () => {
  it("无 token → 401", async () => {
    const res = await app.request("/api/v1/teams", {}, TEST_ENV);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
  });

  it("customer 账号即使 role=system_admin 也 403 ADMIN_ONLY（闸门在查库之前）", async () => {
    const user = userRow({ account_type: "customer", role: "system_admin" });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/teams", user);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: {
        error: "forbidden", code: "ADMIN_ONLY", message: "仅平台管理员可查看全部团队",
      },
    });
    // 只发生了 requireUser 的 users 查询，没有触达 teams
    expect(dbState.calls).toHaveLength(1);
    expect(dbState.calls[0]!.query).toContain("FROM users WHERE id");
  });

  it("internal + 管理员 → 200，团队聚合字段按 Python 投影（member/workstation 计数）", async () => {
    const user = userRow({ account_type: "internal", role: "system_admin" });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM teams t")) {
        return [{
          id: 11,
          name: "Acme Team",
          created_by: 5,
          created_at: new Date("2026-10-01T00:00:00Z"),
          created_by_email: "owner@qa.test",
          created_by_name: "Owner",
          member_count: "3",
          workstation_count: "2",
          workstation_codes: ["customers", "orders"],
        }];
      }
      return [];
    });

    const res = await request("/api/v1/teams", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{
        id: 11,
        name: "Acme Team",
        created_by: 5,
        created_by_email: "owner@qa.test",
        created_by_name: "Owner",
        member_count: 3,
        workstation_count: 2,
        workstation_codes: ["customers", "orders"],
        created_at: "2026-10-01T00:00:00.000+00:00",
      }],
      total: 1,
    });
  });
});

describe("GET /api/v1/teams/me", () => {
  it("未加入团队 → {team:null,is_admin:false,member_count:0}（ws_teams.py:235-236）", async () => {
    const user = userRow({ team_id: null });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/teams/me", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ team: null, is_admin: false, member_count: 0 });
  });

  it("已加入团队 → team/member_count/is_admin 三键", async () => {
    const user = userRow({ team_id: 11 });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("JOIN users u ON u.team_id")) return [TEAM_ROW];
      if (query.includes("count(*) FROM users WHERE team_id")) return [{ count: "4" }];
      return [];
    });

    const res = await request("/api/v1/teams/me", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      team: { id: 11, name: "Acme Team", created_by: 5, is_admin: true, member_count: 4 },
      is_admin: true,
      member_count: 4,
    });
  });
});

describe("POST /api/v1/teams", () => {
  it("已在团队 → 409 ALREADY_IN_TEAM（不查库）", async () => {
    const user = userRow({ team_id: 11 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/teams", user, postJson({ name: "New Team" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      detail: {
        error: "conflict", code: "ALREADY_IN_TEAM", message: "你已属于一个团队，不能再创建团队",
      },
    });
    expect(dbState.calls).toHaveLength(1);
  });

  it("创建成功 → 201，创建者成为团队管理员，显式勾选的工位逐个开通", async () => {
    const user = userRow({ team_id: null });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("INSERT INTO teams")) return [TEAM_ROW];
      return [];
    });

    const res = await request("/api/v1/teams", user, postJson({
      name: "  Acme   Team  ",
      workstations: ["customers"],
    }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: 11,
      name: "Acme Team",
      created_by: 5,
      is_admin: true,
      member_count: 1,
      workstations: ["customers"],
    });
    // 名称规范化走 kaas_common 镜像（去首尾/折叠内部空白）
    expect(dbCallsContaining("INSERT INTO teams")[0]!.params[1]).toBe("Acme Team");
    expect(dbCallsContaining("INSERT INTO team_subscriptions")).toHaveLength(1);
  });

  it("不传 workstations → 默认开通全部工位（不传 ≠ 空数组）", async () => {
    const user = userRow({ team_id: null });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("INSERT INTO teams")) return [TEAM_ROW];
      return [];
    });

    const res = await request("/api/v1/teams", user, postJson({ name: "Acme Team" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ workstations: ALL_WORKSTATIONS });
    expect(dbCallsContaining("INSERT INTO team_subscriptions")).toHaveLength(9);
  });
});

describe("团队管理闸门（_require_team_admin）", () => {
  it("非创建者/非平台管理员 PATCH 团队 → 403 NOT_TEAM_ADMIN", async () => {
    const user = userRow({ id: 2, role: "user", team_id: 11 });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("SELECT * FROM teams WHERE tenant_id")) return [TEAM_ROW];
      return [];
    });

    const res = await request("/api/v1/teams/11", user, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: {
        error: "forbidden", code: "NOT_TEAM_ADMIN", message: "仅团队管理员可管理该团队",
      },
    });
  });

  it("团队订阅列表同样受团队管理员闸门保护（ws_workstations.py:142-152）", async () => {
    const user = userRow({ id: 2, role: "user", team_id: 11 });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("SELECT * FROM teams WHERE id")) return [TEAM_ROW];
      return [];
    });

    const res = await request("/api/v1/teams/11/subscriptions", user);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: {
        error: "forbidden", code: "NOT_TEAM_ADMIN",
        message: "仅团队管理员可管理该团队的工位开通",
      },
    });
  });
});

describe("POST /api/v1/teams/join", () => {
  it("空邀请码 → 422 INVALID_INVITE_TOKEN（不查库）", async () => {
    const user = userRow({ team_id: null });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/teams/join", user, postJson({ token: "   " }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "validation", code: "INVALID_INVITE_TOKEN", detail: "邀请码不能为空",
      },
    });
    expect(dbState.calls).toHaveLength(1);
  });
});
