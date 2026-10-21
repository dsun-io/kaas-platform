/**
 * W5 M1 · 对外 API token 基座测试。
 *
 * 覆盖：
 * - mint/hash：`kaas_oat_` + 32 字节 base64url、sha256 hex 稳定、prefix 可识别；
 * - verifyApiToken：成功 / 过期 / 已撤销 / 未知 / 非本前缀；成功才更新 last_used_at；
 * - hasScope：精确匹配；
 * - resolveActor：Bearer 前缀分流（kaas_oat_ → API token，否则 JWT）；
 * - 管理路由：JWT-only（API token 不能自举提权）、401/200、创建只回一次 plaintext、
 *   未知 scope 422、吊销幂等语义（重复 409）。
 *
 * DB 用 tests/db-mock.ts（withDb → fakeSql），不建真实连接。
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveActor } from "../src/actor";
import { withDb } from "../src/db";
import type { Env } from "../src/env";
import { respond } from "../src/http";
import app from "../src/index";
import { createToken } from "../src/session";
import {
  API_TOKEN_PREFIX,
  API_TOKEN_SCOPES,
  hashApiToken,
  hasScope,
  mintApiToken,
  verifyApiToken,
} from "../src/tokens";
import {
  dbCallsContaining,
  dbState,
  FIXED_SECRET,
  resetDb,
  TEST_ENV,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

// ── 固定桩 ──────────────────────────────────────────────────────────────────

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

function tokenRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 3,
    tenant_id: "default",
    team_id: null,
    name: "CI token",
    scopes: ["customers:read"],
    prefix: "kaas_oat_AbCdEf12",
    created_at: new Date("2026-10-21T03:00:00Z"),
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

async function jwtRequest(
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

function bearer(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

beforeEach(() => {
  resetDb(() => []);
});

// ── mint / hash ────────────────────────────────────────────────────────────

describe("mintApiToken / hashApiToken", () => {
  it("明文 = kaas_oat_ + 32 字节 base64url（43 字符，URL 安全）", () => {
    const token = mintApiToken();

    expect(token.plaintext.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(token.plaintext).toMatch(/^kaas_oat_[A-Za-z0-9_-]{43}$/);
  });

  it("prefix 是明文的可识别前缀（不含完整秘密）", () => {
    const token = mintApiToken();

    expect(token.plaintext.startsWith(token.prefix)).toBe(true);
    expect(token.prefix.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(token.prefix.length).toBe(API_TOKEN_PREFIX.length + 8);
    expect(token.prefix.length).toBeLessThan(token.plaintext.length);
  });

  it("每次 mint 都不同（随机源）", () => {
    const a = mintApiToken();
    const b = mintApiToken();

    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("tokenHash = sha256(plaintext) 小写 hex，且稳定（已知向量）", () => {
    expect(hashApiToken("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(hashApiToken("hello")).toBe(hashApiToken("hello"));
    const token = mintApiToken();
    expect(token.tokenHash).toBe(hashApiToken(token.plaintext));
    expect(token.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── verifyApiToken ─────────────────────────────────────────────────────────

describe("verifyApiToken", () => {
  it("命中未撤销未过期 token → 返回身份并更新 last_used_at", async () => {
    resetDb((query) => (
      query.includes("FROM api_tokens")
        ? [tokenRow({ team_id: 4, scopes: ["customers:read", "quotes:calc"], name: "Robot" })]
        : []
    ));
    const minted = mintApiToken();

    const actor = await withDb(TEST_ENV, (sql) => verifyApiToken(sql, minted.plaintext));

    expect(actor).toEqual({
      id: 3,
      tenantId: "default",
      teamId: 4,
      scopes: ["customers:read", "quotes:calc"],
      name: "Robot",
    });
    // 查的是 sha256，不是明文
    const lookup = dbCallsContaining("FROM api_tokens")[0];
    expect(lookup?.params[0]).toBe(hashApiToken(minted.plaintext));
    expect(lookup?.query).toContain("revoked_at IS NULL");
    expect(lookup?.query).toContain("expires_at IS NULL OR expires_at > now()");
    // 成功后才写 last_used_at
    const touch = dbCallsContaining("UPDATE api_tokens");
    expect(touch).toHaveLength(1);
    expect(touch[0]?.query).toContain("last_used_at = now()");
    expect(touch[0]?.params).toEqual([3]);
  });

  it("过期 token 被 SQL 过滤 → null（不更新 last_used_at）", async () => {
    // 模拟库侧过滤后无有效行
    resetDb(() => []);
    const minted = mintApiToken();

    const actor = await withDb(TEST_ENV, (sql) => verifyApiToken(sql, minted.plaintext));

    expect(actor).toBeNull();
    expect(dbCallsContaining("FROM api_tokens")[0]?.query).toContain(
      "expires_at IS NULL OR expires_at > now()",
    );
    expect(dbCallsContaining("UPDATE api_tokens")).toHaveLength(0);
  });

  it("已撤销 token 被 SQL 过滤 → null", async () => {
    resetDb(() => []);
    const minted = mintApiToken();

    const actor = await withDb(TEST_ENV, (sql) => verifyApiToken(sql, minted.plaintext));

    expect(actor).toBeNull();
    expect(dbCallsContaining("FROM api_tokens")[0]?.query).toContain("revoked_at IS NULL");
    expect(dbCallsContaining("UPDATE api_tokens")).toHaveLength(0);
  });

  it("未知 token → null，且不做任何写操作", async () => {
    resetDb(() => []);
    const minted = mintApiToken();

    const actor = await withDb(TEST_ENV, (sql) => verifyApiToken(sql, minted.plaintext));

    expect(actor).toBeNull();
    expect(dbState.calls).toHaveLength(1);
    expect(dbCallsContaining("UPDATE api_tokens")).toHaveLength(0);
  });

  it("非 kaas_oat_ 前缀 → 直接 null，不查库", async () => {
    resetDb(() => [tokenRow()]);

    const actor = await withDb(TEST_ENV, (sql) => verifyApiToken(sql, "some-jwt-or-junk"));

    expect(actor).toBeNull();
    expect(dbState.calls).toHaveLength(0);
  });
});

// ── hasScope ───────────────────────────────────────────────────────────────

describe("hasScope", () => {
  it("精确匹配已声明的 scope", () => {
    expect(hasScope({ scopes: ["customers:read"] }, "customers:read")).toBe(true);
  });

  it("未声明 / 大小写不同 / 前缀相近都不匹配", () => {
    expect(hasScope({ scopes: ["customers:read"] }, "customers:write")).toBe(false);
    expect(hasScope({ scopes: ["customers:read"] }, "customers:read:all")).toBe(false);
    expect(hasScope({ scopes: ["Customers:read"] }, "customers:read")).toBe(false);
  });

  it("actor 缺失或 scopes 为空 → false", () => {
    expect(hasScope(null, "customers:read")).toBe(false);
    expect(hasScope(undefined, "customers:read")).toBe(false);
    expect(hasScope({ scopes: null }, "customers:read")).toBe(false);
  });
});

// ── resolveActor（Bearer 分流）─────────────────────────────────────────────

describe("resolveActor", () => {
  const probe = new Hono<{ Bindings: Env }>();
  probe.get("/probe", (c) => respond(c, async () => c.json(await resolveActor(c))));

  it("缺 Bearer → 401 Authentication required", async () => {
    const res = await probe.request("/probe", {}, TEST_ENV);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
  });

  it("kaas_oat_ token 有效 → API token actor（不回查 users）", async () => {
    resetDb((query) => (
      query.includes("FROM api_tokens")
        ? [tokenRow({ team_id: 4, scopes: ["trade_docs:read"] })]
        : []
    ));
    const minted = mintApiToken();

    const res = await probe.request(
      "/probe",
      bearer(minted.plaintext),
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: "api_token",
      tokenId: 3,
      tenantId: "default",
      teamId: 4,
      scopes: ["trade_docs:read"],
      name: "CI token",
    });
    expect(dbCallsContaining("FROM users WHERE id")).toHaveLength(0);
  });

  it("kaas_oat_ token 无效/过期/撤销 → 401（不回落 JWT）", async () => {
    resetDb(() => []);
    const minted = mintApiToken();

    const res = await probe.request("/probe", bearer(minted.plaintext), TEST_ENV);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Invalid or expired token" },
    });
    expect(dbCallsContaining("FROM users WHERE id")).toHaveLength(0);
  });

  it("非 kaas_oat_ Bearer → 走 JWT（requireUser 语义）", async () => {
    const user = userRow({ id: 9, team_id: 4 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await probe.request(
      "/probe",
      bearer(await createToken(9, FIXED_SECRET)),
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string; teamId: number | null; scopes: unknown };
    expect(body.kind).toBe("user");
    expect(body.teamId).toBe(4);
    expect(body.scopes).toBeNull();
  });

  it("JWT 非法 → 401 Invalid or expired token", async () => {
    const res = await probe.request("/probe", bearer("not-a-jwt"), TEST_ENV);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Invalid or expired token" },
    });
  });
});

// ── 管理路由：JWT-only ─────────────────────────────────────────────────────

describe("GET /api/v1/api-tokens", () => {
  it("无 JWT → 401", async () => {
    const res = await app.request("/api/v1/api-tokens", {}, TEST_ENV);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
  });

  it("有 JWT → 200，返回列表但永不返回 hash/plaintext", async () => {
    const user = userRow({ id: 5 });
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM api_tokens")) {
        return [tokenRow({
          id: 7,
          name: "CI",
          scopes: ["customers:read"],
          last_used_at: new Date("2026-10-21T04:00:00Z"),
        })];
      }
      return [];
    });

    const res = await jwtRequest("/api/v1/api-tokens", user);

    expect(res.status).toBe(200);
    const body = await res.json() as { items: DbRow[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toEqual({
      id: 7,
      name: "CI",
      prefix: "kaas_oat_AbCdEf12",
      scopes: ["customers:read"],
      created_at: "2026-10-21T03:00:00.000+00:00",
      last_used_at: "2026-10-21T04:00:00.000+00:00",
      expires_at: null,
      revoked_at: null,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("token_hash");
    expect(serialized).not.toContain("plaintext");
  });

  it("列表 SQL 以 tenant + created_by（本人）为边界", async () => {
    const user = userRow({ id: 5 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    await jwtRequest("/api/v1/api-tokens", user);

    const list = dbCallsContaining("FROM api_tokens")[0];
    expect(list?.query).toContain("tenant_id = ?");
    expect(list?.query).toContain("created_by = ?");
    expect(list?.params).toContain("default");
    expect(list?.params).toContain(5);
  });
});

describe("POST /api/v1/api-tokens", () => {
  it("有 JWT → 201，plaintext 只出现一次，库里只写 hash", async () => {
    const user = userRow({ id: 5 });
    resetDb((query, params) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("INSERT INTO api_tokens")) {
        return [tokenRow({
          id: 7,
          name: params[2] as string,
          scopes: params[3] as string[],
          prefix: params[5] as string,
        })];
      }
      return [];
    });

    const res = await jwtRequest(
      "/api/v1/api-tokens",
      user,
      postJson({ name: "CI token", scopes: ["customers:read", "quotes:calc"] }),
    );

    expect(res.status).toBe(201);
    const body = await res.json() as DbRow & { plaintext: string };
    expect(body.plaintext).toMatch(/^kaas_oat_[A-Za-z0-9_-]{43}$/);
    expect(body.prefix).toBe(body.plaintext.slice(0, String(body.prefix).length));
    expect(body).not.toHaveProperty("token_hash");

    const insert = dbCallsContaining("INSERT INTO api_tokens")[0];
    expect(insert?.params[0]).toBe("default");
    expect(insert?.params[1]).toBeNull(); // user.team_id = null
    expect(insert?.params[2]).toBe("CI token");
    // fetch_types:false 下数组以 PG 字面量 + ::text[] 强转传参（生产实测 22P02 修复）
    expect(insert?.params[3]).toBe('{"customers:read","quotes:calc"}');
    expect(insert?.params[4]).toBe(hashApiToken(body.plaintext));
    expect(insert?.params[5]).toBe(body.prefix);
    expect(insert?.params[6]).toBe(5);
    // 明文绝不能作为参数进库
    expect(insert?.params).not.toContain(body.plaintext);
  });

  it("创建后列表响应不含 plaintext（只显示一次）", async () => {
    const user = userRow({ id: 5 });
    resetDb((query, params) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("INSERT INTO api_tokens")) {
        return [tokenRow({ id: 7, prefix: params[5] as string, name: "CI token" })];
      }
      if (query.includes("FROM api_tokens")) {
        return [tokenRow({ id: 7, prefix: "kaas_oat_AbCdEf12", name: "CI token" })];
      }
      return [];
    });

    const created = await jwtRequest(
      "/api/v1/api-tokens",
      user,
      postJson({ name: "CI token", scopes: [] }),
    );
    const createdBody = await created.json() as { plaintext: string };
    const listed = await jwtRequest("/api/v1/api-tokens", user);
    const listedText = await listed.text();

    expect(createdBody.plaintext).toMatch(/^kaas_oat_/);
    expect(listedText).not.toContain(createdBody.plaintext);
    expect(listedText).not.toContain("plaintext");
  });

  it("未知 scope → 422，且不写库", async () => {
    const user = userRow({ id: 5 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await jwtRequest(
      "/api/v1/api-tokens",
      user,
      postJson({ name: "bad", scopes: ["customers:read", "customers:delete"] }),
    );

    expect(res.status).toBe(422);
    const body = await res.json() as { detail: { code: string; message: string } };
    expect(body.detail.code).toBe("UNKNOWN_SCOPE");
    expect(body.detail.message).toContain("customers:delete");
    expect(dbCallsContaining("INSERT INTO api_tokens")).toHaveLength(0);
  });

  it("缺 name → 422（zod 手写校验）", async () => {
    const user = userRow({ id: 5 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await jwtRequest(
      "/api/v1/api-tokens",
      user,
      postJson({ scopes: ["customers:read"] }),
    );

    expect(res.status).toBe(422);
  });

  it("expires_in_days → 写入 expires_at 日期", async () => {
    const user = userRow({ id: 5 });
    resetDb((query, params) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("INSERT INTO api_tokens")) {
        return [tokenRow({ id: 7, expires_at: params[7] })];
      }
      return [];
    });

    const res = await jwtRequest(
      "/api/v1/api-tokens",
      user,
      postJson({ name: "temp", scopes: [], expires_in_days: 30 }),
    );

    expect(res.status).toBe(201);
    const insert = dbCallsContaining("INSERT INTO api_tokens")[0];
    expect(insert?.params[7]).toBeInstanceOf(Date);
  });
});

describe("DELETE /api/v1/api-tokens/:id", () => {
  it("软撤销成功 → 200 {revoked:true}", async () => {
    const user = userRow({ id: 5 });
    const revokedAt = new Date("2026-10-21T05:00:00Z");
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("UPDATE api_tokens")) {
        return [tokenRow({ id: 7, revoked_at: revokedAt })];
      }
      return [];
    });

    const res = await jwtRequest("/api/v1/api-tokens/7", user, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      revoked: true,
      id: 7,
      revoked_at: "2026-10-21T05:00:00.000+00:00",
    });
    const update = dbCallsContaining("UPDATE api_tokens")[0];
    expect(update?.query).toContain("revoked_at = now()");
    expect(update?.query).toContain("revoked_at IS NULL");
    expect(update?.params).toContain(7);
  });

  it("重复撤销 → 409 TOKEN_ALREADY_REVOKED（不物理删除）", async () => {
    const user = userRow({ id: 5 });
    let alreadyRevoked = false;
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("UPDATE api_tokens")) {
        if (alreadyRevoked) return [];
        alreadyRevoked = true;
        return [tokenRow({ id: 7, revoked_at: new Date() })];
      }
      if (query.includes("SELECT id, revoked_at FROM api_tokens")) {
        return [tokenRow({ id: 7, revoked_at: new Date() })];
      }
      return [];
    });

    const first = await jwtRequest("/api/v1/api-tokens/7", user, { method: "DELETE" });
    const second = await jwtRequest("/api/v1/api-tokens/7", user, { method: "DELETE" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      detail: { error: "conflict", code: "TOKEN_ALREADY_REVOKED" },
    });
    expect(dbCallsContaining("DELETE FROM api_tokens")).toHaveLength(0);
  });

  it("不存在 / 非本人 → 404", async () => {
    const user = userRow({ id: 5 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await jwtRequest("/api/v1/api-tokens/999", user, { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: { error: "not_found", code: "TOKEN_NOT_FOUND" },
    });
  });

  it("非法 id → 422（路径参数校验）", async () => {
    const user = userRow({ id: 5 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await jwtRequest("/api/v1/api-tokens/abc", user, { method: "DELETE" });

    expect(res.status).toBe(422);
  });
});

// ── 防自举提权：API token 不能访问管理端点 ────────────────────────────────

describe("管理端点只接受 JWT（API token 自举提权防护）", () => {
  it("GET / POST / DELETE 带 kaas_oat_ token 一律 401，且不查 api_tokens", async () => {
    const user = userRow({ id: 5 });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));
    const minted = mintApiToken();

    const calls: Array<[string, RequestInit]> = [
      ["/api/v1/api-tokens", { method: "GET" }],
      ["/api/v1/api-tokens", postJson({ name: "escalate", scopes: ["customers:write"] })],
      ["/api/v1/api-tokens/7", { method: "DELETE" }],
    ];
    for (const [path, init] of calls) {
      const res = await app.request(path, bearer(minted.plaintext, init), TEST_ENV);
      expect(res.status, `${init.method} ${path}`).toBe(401);
      expect(await res.json()).toEqual({
        detail: { error: "unauthorized", message: "Invalid or expired token" },
      });
    }
    // requireUser 在 JWT 校验阶段就失败，不会进入 token 管理查询
    expect(dbCallsContaining("FROM api_tokens")).toHaveLength(0);
    expect(dbCallsContaining("INSERT INTO api_tokens")).toHaveLength(0);
  });

  it("scope 白名单是公开可枚举的元数据（不含业务判定）", () => {
    expect(API_TOKEN_SCOPES).toContain("customers:read");
    expect(API_TOKEN_SCOPES).toContain("quotes:calc");
    expect(API_TOKEN_SCOPES.every((scope) => scope.includes(":"))).toBe(true);
  });
});
