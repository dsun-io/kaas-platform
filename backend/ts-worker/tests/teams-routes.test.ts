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

// ── 加入申请（2026-10-22）：契约 = ws_join_applications.py ────────────────────

const APPLICATION_ROW: DbRow = {
  id: 31,
  team_id: 11,
  user_id: 77,
  email: "applicant@qa.test",
  display_name: "申请人",
  message: "想加入",
  status: "pending",
  reviewed_by: null,
  reviewed_at: null,
  reject_reason: null,
  created_at: new Date("2026-10-22T02:00:00Z"),
  updated_at: null,
};

describe("GET /api/v1/teams/check-name（公开只读）", () => {
  it("不需要 token；只回 {name,exists}，不返回团队详情", async () => {
    resetDb((query) => (query.includes("FROM teams WHERE tenant_id") ? [{ "?column?": 1 }] : []));

    const res = await app.request("/api/v1/teams/check-name?name=%20Acme%20Team%20", {}, TEST_ENV);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Acme Team", exists: true });
  });

  it("空名 → 422 INVALID_TEAM_NAME（不查库）", async () => {
    resetDb(() => []);

    const res = await app.request("/api/v1/teams/check-name?name=%20%20", {}, TEST_ENV);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: { error: "validation", code: "INVALID_TEAM_NAME", detail: "团队名称不能为空" },
    });
    expect(dbState.calls).toHaveLength(0);
  });
});

describe("GET /api/v1/teams/{id}/join-applications", () => {
  it("非团队管理员 → 403 NOT_TEAM_ADMIN", async () => {
    const user = userRow({ team_id: 11, role: "user", id: 6 });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM teams WHERE tenant_id")) return [TEAM_ROW];
      return [];
    });

    const res = await request("/api/v1/teams/11/join-applications", user);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: { error: "forbidden", code: "NOT_TEAM_ADMIN", message: "仅团队管理员可管理该团队" },
    });
  });

  it("管理员 → 200，默认只看 pending，字段与内核 _application_out 对齐", async () => {
    const user = userRow({ team_id: 11 });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM teams WHERE tenant_id")) return [TEAM_ROW];
      if (query.includes("FROM team_join_applications")) return [APPLICATION_ROW];
      return [];
    });

    const res = await request("/api/v1/teams/11/join-applications", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{
        id: 31,
        team_id: 11,
        team_name: null,
        user_id: 77,
        email: "applicant@qa.test",
        display_name: "申请人",
        message: "想加入",
        status: "pending",
        reject_reason: null,
        reviewed_by: null,
        reviewed_at: null,
        created_at: "2026-10-22T02:00:00.000+00:00",
      }],
      total: 1,
    });
    expect(dbCallsContaining("AND status=").length).toBe(1);
  });

  it("status=bogus → 422 INVALID_STATUS", async () => {
    const user = userRow({ team_id: 11 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/teams/11/join-applications?status=bogus", user);

    expect(res.status).toBe(422);
    expect((await res.json() as { detail: { code: string } }).detail.code).toBe("INVALID_STATUS");
  });
});

describe("POST /api/v1/teams/{id}/join-applications/{aid}/approve", () => {
  it("通过：落 users.team_id + 申请 approved + member_count", async () => {
    const user = userRow({ team_id: 11 });
    resetDb((query) => {
      if (query.includes("SELECT id, team_id FROM users")) return [{ id: 77, team_id: null }];
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM teams WHERE tenant_id")) return [TEAM_ROW];
      if (query.includes("FROM team_join_applications WHERE id=")) return [APPLICATION_ROW];
      if (query.includes("UPDATE team_join_applications")) {
        return [{ ...APPLICATION_ROW, status: "approved", reviewed_by: 5 }];
      }
      if (query.includes("count(*) FROM users WHERE team_id")) return [{ count: "3" }];
      return [];
    });

    const res = await request("/api/v1/teams/11/join-applications/31/approve", user, postJson({}));

    expect(res.status).toBe(200);
    const body = await res.json() as { approved: boolean; member_count: number; application: { status: string } };
    expect(body.approved).toBe(true);
    expect(body.member_count).toBe(3);
    expect(body.application.status).toBe("approved");
    expect(dbCallsContaining("UPDATE users SET team_id=").length).toBe(1);
    expect(dbCallsContaining("FOR UPDATE").length).toBeGreaterThan(0);
  });

  it("非 pending → 409 APPLICATION_ALREADY_REVIEWED", async () => {
    const user = userRow({ team_id: 11 });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM teams WHERE tenant_id")) return [TEAM_ROW];
      if (query.includes("FROM team_join_applications WHERE id=")) {
        return [{ ...APPLICATION_ROW, status: "approved" }];
      }
      return [];
    });

    const res = await request("/api/v1/teams/11/join-applications/31/approve", user, postJson({}));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      detail: {
        error: "conflict", code: "APPLICATION_ALREADY_REVIEWED",
        message: "该申请已被处理，不能重复审核",
      },
    });
    expect(dbCallsContaining("UPDATE users SET team_id=")).toHaveLength(0);
  });

  it("申请人已属其他团队 → 409 ALREADY_IN_TEAM", async () => {
    const user = userRow({ team_id: 11 });
    resetDb((query) => {
      if (query.includes("SELECT id, team_id FROM users")) return [{ id: 77, team_id: 99 }];
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM teams WHERE tenant_id")) return [TEAM_ROW];
      if (query.includes("FROM team_join_applications WHERE id=")) return [APPLICATION_ROW];
      return [];
    });

    const res = await request("/api/v1/teams/11/join-applications/31/approve", user, postJson({}));

    expect(res.status).toBe(409);
    expect((await res.json() as { detail: { code: string } }).detail.code).toBe("ALREADY_IN_TEAM");
  });
});

describe("POST /api/v1/teams/{id}/join-applications/{aid}/reject", () => {
  it("理由超长 → 422 REJECT_REASON_TOO_LONG", async () => {
    const user = userRow({ team_id: 11 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request(
      "/api/v1/teams/11/join-applications/31/reject", user, postJson({ reason: "长".repeat(201) }),
    );

    expect(res.status).toBe(422);
    expect((await res.json() as { detail: { code: string } }).detail.code).toBe("REJECT_REASON_TOO_LONG");
  });

  it("驳回写入理由 → 200", async () => {
    const user = userRow({ team_id: 11 });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM teams WHERE tenant_id")) return [TEAM_ROW];
      if (query.includes("FROM team_join_applications WHERE id=")) return [APPLICATION_ROW];
      if (query.includes("UPDATE team_join_applications")) {
        return [{ ...APPLICATION_ROW, status: "rejected", reject_reason: "请用公司邮箱" }];
      }
      return [];
    });

    const res = await request(
      "/api/v1/teams/11/join-applications/31/reject", user, postJson({ reason: " 请用公司邮箱 " }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { rejected: boolean; application: { reject_reason: string } };
    expect(body.rejected).toBe(true);
    expect(body.application.reject_reason).toBe("请用公司邮箱");
  });
});

describe("GET /api/v1/me/join-application 与撤回", () => {
  it("没有申请 → {application:null}", async () => {
    const user = userRow({ team_id: null });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/me/join-application", user);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ application: null });
  });

  it("撤回：本人 pending → canceled，并带团队名", async () => {
    const user = userRow({ team_id: null, id: 77 });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM team_join_applications WHERE id=")) return [APPLICATION_ROW];
      if (query.includes("UPDATE team_join_applications")) {
        return [{ ...APPLICATION_ROW, status: "canceled" }];
      }
      if (query.includes("SELECT name FROM teams")) return [{ name: "Acme Team" }];
      return [];
    });

    const res = await request("/api/v1/join-applications/31/cancel", user, postJson({}));

    expect(res.status).toBe(200);
    const body = await res.json() as { canceled: boolean; application: { status: string; team_name: string } };
    expect(body.canceled).toBe(true);
    expect(body.application.status).toBe("canceled");
    expect(body.application.team_name).toBe("Acme Team");
  });

  it("撤回别人的申请 → 404 APPLICATION_NOT_FOUND", async () => {
    const user = userRow({ team_id: null, id: 88 });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM team_join_applications WHERE id=")) return [APPLICATION_ROW];
      return [];
    });

    const res = await request("/api/v1/join-applications/31/cancel", user, postJson({}));

    expect(res.status).toBe(404);
    expect((await res.json() as { detail: { code: string } }).detail.code).toBe("APPLICATION_NOT_FOUND");
  });
});
