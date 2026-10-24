/**
 * P1 认证域（9 条路由）直连 DB 测试 —— 真源 backend/worker/src/main.py:295-943。
 *
 * 覆盖 task-5 测试清单：
 * - 登录成功 / 密码错 / 用户不存在 / 账号禁用；JWT claims 与 Python 逐字一致（仅 sub/iat/exp，1440min）；
 * - JWT 过期 / 签名错 → 401 且不查库（应用层，不是单测层面）；
 * - change-password（重哈希 $2b$12$ + 旧密码校验）；
 * - reset-password（token 哈希口径 / 新密码可登录 / 旧 token 作废）与 forgot-password（Resend 发信）；
 * - bootstrap-admin（幂等 / 401/403/409/503/422）；
 * - **KERNEL.fetch 0 次**：AUTH_DB_SPLIT 任意态下认证域都不触达 Python 内核。
 *
 * DB 用 helpers.resetDb 按 SQL 片段打桩（vi.mock ../src/db → tests/db-mock.ts）。
 * Resend 用 vi.stubGlobal("fetch") 截获，断言 URL/Authorization/from/to/subject/链接与落库哈希。
 */
import { createHash } from "node:crypto";
import { SignJWT, decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { verifyPassword } from "../src/auth";
import { createToken } from "../src/session";
import {
  FIXED_SECRET,
  PYTHON_BCRYPT_HASH,
  TEST_ENV,
  TEST_PASSWORD,
  dbState,
  makeTestEnv,
  resetDb,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

const BCRYPT_COST12 = "$2b$12$";
const DEFAULT_FROM = "noreply@send.powervoy.com";

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

async function jsonRequest(
  path: string,
  body: unknown,
  env: typeof TEST_ENV = TEST_ENV,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return await app.request(path, { method: "POST", headers, body: JSON.stringify(body) }, env);
}

async function getRequest(
  path: string,
  env: typeof TEST_ENV = TEST_ENV,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = "Bearer " + token;
  return await app.request(path, { headers }, env);
}

/** Resend 替身：记录每次出站请求（URL + init），返回 200 {id}。 */
function stubResend(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ id: "re_test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** 取第 n 次出站请求的 JSON body（Resend 邮件的载荷）。 */
function resendPayload(spy: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const call = spy.mock.calls[index];
  expect(call, "Resend 应被调用第 " + String(index + 1) + " 次").toBeTruthy();
  return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
}

/** 从纯文本/HTML 正文里取 raw reset token（base64url，43 字符）。 */
function extractRawToken(text: string): string {
  const m = /token=([A-Za-z0-9_-]{20,})/.exec(text);
  expect(m, "邮件正文应包含重置链接").not.toBeNull();
  return m![1]!;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

beforeEach(() => {
  resetDb(() => []);
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/auth/login（main.py:338-369）
// ══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/auth/login（补充：不存在 / claims）", () => {
  it("用户不存在 → 401 Invalid credentials（与密码错同信封，不泄露账号存在性）", async () => {
    resetDb(() => []);
    const res = await jsonRequest("/api/v1/auth/login", {
      email: "nobody@qa.test",
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: "Invalid credentials" });
  });

  it("签发的 JWT claims 与 Python _create_token 逐字一致：仅 sub/iat/exp，exp=iat+1440min", async () => {
    resetDb((query) => {
      if (query.includes("FROM users WHERE email=")) return [LOGIN_ROW];
      if (query.includes("FROM teams WHERE id")) return [{ name: "Acme Team" }];
      return [];
    });
    const res = await jsonRequest("/api/v1/auth/login", {
      email: LOGIN_ROW.email,
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };

    const claims = decodeJwt(body.access_token) as Record<string, unknown>;
    // Python main.py:132-138：payload = {sub, exp, iat}（没有 tenant_id/team_id/scope）
    expect(Object.keys(claims).sort()).toEqual(["exp", "iat", "sub"]);
    expect(claims.sub).toBe("5");
    expect(Number(claims.exp) - Number(claims.iat)).toBe(1440 * 60);
    // HS256 三段式
    expect(body.access_token.split(".")).toHaveLength(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/auth/me：JWT 过期 / 签名错（应用层，不查库）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/auth/me（JWT 过期 / 签名错）", () => {
  const now = Math.floor(Date.now() / 1000);

  it("过期 token → 401 Invalid or expired token，且不查库（Python _decode_token 同信封）", async () => {
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(ME_ROW.id))
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(new TextEncoder().encode(FIXED_SECRET));

    const res = await getRequest("/api/v1/auth/me", TEST_ENV, expired);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Invalid or expired token" },
    });
    expect(dbState.calls).toHaveLength(0);
  });

  it("签名错（另一 secret 签的合法结构 token）→ 401，且不查库", async () => {
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(ME_ROW.id))
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode("another-secret-at-least-32-chars-x!"));

    const res = await getRequest("/api/v1/auth/me", TEST_ENV, forged);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Invalid or expired token" },
    });
    expect(dbState.calls).toHaveLength(0);
  });

  it("账号被禁用 → 401 User not found or disabled（与 Python _get_current_user 同口径）", async () => {
    resetDb((query) => (query.includes("FROM users WHERE id") ? [{ ...ME_ROW, status: "disabled" }] : []));
    const token = await createToken(ME_ROW.id, FIXED_SECRET);
    const res = await getRequest("/api/v1/auth/me", TEST_ENV, token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "User not found or disabled" },
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/auth/logout（main.py:409-417）
// ══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/auth/logout", () => {
  it("stateless：200 同响应体，不写库（与 Python/orchestrator 同口径）", async () => {
    const res = await jsonRequest("/api/v1/auth/logout", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Logged out (client should discard token)" });
    expect(dbState.calls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/auth/change-password（main.py:479-508）
// ══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/auth/change-password", () => {
  const NEW_PASSWORD = "brand-new-password-1";

  it("成功：验旧密码 + bcrypt 重哈希（$2b$12$）+ 返回 Password updated", async () => {
    resetDb((query) => {
      if (query.includes("SELECT password_hash FROM users WHERE id")) {
        return [{ password_hash: PYTHON_BCRYPT_HASH }];
      }
      if (query.includes("FROM users WHERE id")) return [ME_ROW];
      return [];
    });
    const token = await createToken(ME_ROW.id, FIXED_SECRET);

    const res = await jsonRequest(
      "/api/v1/auth/change-password",
      { current_password: TEST_PASSWORD, new_password: NEW_PASSWORD },
      TEST_ENV,
      token,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Password updated" });

    const update = dbState.calls.find((call) => call.query.includes("UPDATE users SET password_hash"));
    expect(update, "应执行 users.password_hash 更新").toBeTruthy();
    const hash = update!.params[0] as string;
    expect(hash.startsWith(BCRYPT_COST12)).toBe(true);
    // 新口令可用该哈希校验通过（bcryptjs 与 Python $2b$ 互通）
    expect(await verifyPassword(NEW_PASSWORD, hash)).toBe(true);
    expect(update!.params[1]).toBe(ME_ROW.id);
  });

  it("旧密码错 → 403 INVALID_CURRENT_PASSWORD（不泄露账号状态）", async () => {
    resetDb((query) => {
      if (query.includes("SELECT password_hash FROM users WHERE id")) {
        return [{ password_hash: PYTHON_BCRYPT_HASH }];
      }
      if (query.includes("FROM users WHERE id")) return [ME_ROW];
      return [];
    });
    const token = await createToken(ME_ROW.id, FIXED_SECRET);

    const res = await jsonRequest(
      "/api/v1/auth/change-password",
      { current_password: "wrong-current", new_password: NEW_PASSWORD },
      TEST_ENV,
      token,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: { error: "forbidden", code: "INVALID_CURRENT_PASSWORD", detail: "当前密码不正确" },
    });
    expect(dbState.calls.some((call) => call.query.includes("UPDATE users SET password_hash"))).toBe(false);
  });

  it("新密码 < 8 → 422 PASSWORD_TOO_SHORT（先校验长度，不查密码）", async () => {
    // 鉴权在参数校验之前（与 FastAPI Depends 顺序一致）：必须能装载到当前用户
    resetDb((query) => (query.includes("FROM users WHERE id") ? [ME_ROW] : []));
    const token = await createToken(ME_ROW.id, FIXED_SECRET);
    const res = await jsonRequest(
      "/api/v1/auth/change-password",
      { current_password: TEST_PASSWORD, new_password: "short" },
      TEST_ENV,
      token,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: { error: "validation", code: "PASSWORD_TOO_SHORT", detail: "Password must be at least 8 characters" },
    });
  });

  it("无 token → 401 Authentication required", async () => {
    const res = await jsonRequest("/api/v1/auth/change-password", {
      current_password: TEST_PASSWORD,
      new_password: NEW_PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
  });
});
// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/auth/forgot-password（main.py:687-720）
// ══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/auth/forgot-password", () => {
  const ACTIVE_ROW = { id: 5, email: "buyer@qa.test", status: "active" };

  function forgotEnv(overrides: Record<string, unknown> = {}) {
    return makeTestEnv({ RESEND_API_KEY: "re_test_key", ...overrides });
  }

  it("已知 active 邮箱：落 token 哈希 + 经 Resend 发信（from/to/subject/链接与 Python 一致）", async () => {
    const spy = stubResend();
    resetDb((query) => (query.includes("FROM users WHERE email=") ? [ACTIVE_ROW] : []));

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "CF-Connecting-IP": "203.0.113.7",
    };
    const res = await app.request(
      "/api/v1/auth/forgot-password",
      { method: "POST", headers, body: JSON.stringify({ email: " Buyer@QA.test " }) },
      forgotEnv(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "如果该邮箱已注册，重置链接已发送" });

    // 邮箱先 strip+lower 再查（main.py:690）
    const lookup = dbState.calls.find((call) => call.query.includes("FROM users WHERE email="));
    expect(lookup!.params[0]).toBe("buyer@qa.test");

    // ① 旧 token 一律作废、② 新 token 只存 sha256、③ 30 分钟过期、④ 记录请求 IP
    expect(dbState.calls.some((call) =>
      call.query.includes("UPDATE password_reset_tokens SET used_at=NOW()"))).toBe(true);
    const insert = dbState.calls.find((call) => call.query.includes("INSERT INTO password_reset_tokens"));
    expect(insert, "应插入 password_reset_tokens 行").toBeTruthy();
    expect(insert!.params[0]).toBe(5);
    const expires = insert!.params[2] as Date;
    expect(Math.abs(expires.getTime() - (Date.now() + 30 * 60_000))).toBeLessThan(10_000);
    expect(insert!.params[3]).toBe("203.0.113.7");

    // ⑤ Resend 出站：URL / Authorization / 载荷逐字段
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.resend.com/emails");
    expect(new Headers((init as RequestInit).headers).get("Authorization")).toBe("Bearer re_test_key");
    const payload = resendPayload(spy);
    expect(payload.from).toBe(DEFAULT_FROM);
    expect(payload.to).toEqual(["buyer@qa.test"]);
    expect(payload.subject).toBe("重置你的登录密码");
    const raw = extractRawToken(String(payload.text));
    expect(raw).toHaveLength(43); // secrets.token_urlsafe(32) → 32 bytes base64url 无填充
    expect(String(payload.html)).toContain("token=" + raw);
    expect(String(payload.html)).toContain("重置你的登录密码");
    expect(String(payload.text)).toContain("30 分钟内有效");
    // ⑥ 落库哈希 = sha256(raw token)（main.py:_hash_reset_token）
    expect(insert!.params[1]).toBe(sha256Hex(raw));
  });

  it("RESET_FROM_EMAIL 覆盖发件人（main.py:659）", async () => {
    const spy = stubResend();
    resetDb((query) => (query.includes("FROM users WHERE email=") ? [ACTIVE_ROW] : []));
    await app.request(
      "/api/v1/auth/forgot-password",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "buyer@qa.test" }) },
      forgotEnv({ RESET_FROM_EMAIL: "reset@kaas.test" }),
    );
    expect(resendPayload(spy).from).toBe("reset@kaas.test");
  });

  it("未注册邮箱 / 非 active 账号：200 恒同、不发信、不落库（不泄露存在性）", async () => {
    const spy = stubResend();
    for (const rows of [[], [{ id: 5, email: "buyer@qa.test", status: "disabled" }]] as const) {
      resetDb(() => rows as never);
      const res = await app.request(
        "/api/v1/auth/forgot-password",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "buyer@qa.test" }) },
        forgotEnv(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, message: "如果该邮箱已注册，重置链接已发送" });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(dbState.calls.some((call) => call.query.includes("INSERT INTO password_reset_tokens"))).toBe(false);
  });

  it("RESEND_API_KEY 缺失：照常落库、不发信、响应 200（Python 静默返回 False 同口径）", async () => {
    const spy = stubResend();
    resetDb((query) => (query.includes("FROM users WHERE email=") ? [ACTIVE_ROW] : []));
    const res = await app.request(
      "/api/v1/auth/forgot-password",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "buyer@qa.test" }) },
      makeTestEnv(),
    );
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(dbState.calls.some((call) => call.query.includes("INSERT INTO password_reset_tokens"))).toBe(true);
  });

  it("Resend 返回 500：发信失败被吞、响应仍 200（main.py:673-675）", async () => {
    const spy = vi.fn(async () => new Response("resend down", { status: 500 }));
    vi.stubGlobal("fetch", spy);
    resetDb((query) => (query.includes("FROM users WHERE email=") ? [ACTIVE_ROW] : []));
    const res = await app.request(
      "/api/v1/auth/forgot-password",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "buyer@qa.test" }) },
      forgotEnv(),
    );
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("非法邮箱 → 422 validation_error: email is required（main.py:691-692）", async () => {
    const res = await jsonRequest("/api/v1/auth/forgot-password", { email: "not-an-email" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ detail: "validation_error: email is required" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/auth/reset-password（main.py:723-758）
// ══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/auth/reset-password", () => {
  // 低熵测试夹具：本测试只关心「原始 token 是否被 sha256 后进 SQL」，值与真实凭据无关。
  // （原写法是高分熵假值，会被 scripts/check-secrets.mjs 的 generic-secret 规则命中 ⇒ 必回退到低熵占位。）
  const FIXTURE_TOKEN = "fixture-token-low-entropy";

  it("成功：新密码重哈希落库 + 该用户全部未用 token 作废；**新密码可登录、旧密码不可**", async () => {
    resetDb((query) => {
      if (query.includes("JOIN users u")) return [{ token_id: 11, user_id: 5, status: "active" }];
      return [];
    });

    const res = await jsonRequest("/api/v1/auth/reset-password", {
      token: "  " + FIXTURE_TOKEN + "  ",
      new_password: "reset-new-password-1",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "密码已重置，请用新密码登录" });

    // token 只以 sha256 形式进 WHERE；原始 token 不落库
    const select = dbState.calls.find((call) => call.query.includes("JOIN users u"));
    expect(select!.params[0]).toBe(sha256Hex(FIXTURE_TOKEN));
    expect(dbState.calls.some((call) => call.params.includes(FIXTURE_TOKEN))).toBe(false);

    const updateUser = dbState.calls.find((call) => call.query.includes("UPDATE users SET password_hash"));
    expect(updateUser, "应更新 users.password_hash").toBeTruthy();
    const newHash = updateUser!.params[0] as string;
    expect(newHash.startsWith(BCRYPT_COST12)).toBe(true);
    expect(await verifyPassword("reset-new-password-1", newHash)).toBe(true);
    expect(await verifyPassword(TEST_PASSWORD, newHash)).toBe(false);

    const used = dbState.calls.find((call) => call.query.includes("UPDATE password_reset_tokens SET used_at"));
    expect(used!.params[0]).toBe(5);

    // 新密码能登录（DB 返回新哈希）
    resetDb((query) => {
      if (query.includes("FROM users WHERE email=")) return [{ ...LOGIN_ROW, password_hash: newHash }];
      if (query.includes("FROM teams WHERE id")) return [{ name: "Acme Team" }];
      return [];
    });
    const loginRes = await jsonRequest("/api/v1/auth/login", {
      email: LOGIN_ROW.email,
      password: "reset-new-password-1",
    });
    expect(loginRes.status).toBe(200);
  });

  it("无效/过期/已用 token → 400 invalid_token（统一信封，不区分原因）", async () => {
    resetDb(() => []);
    const res = await jsonRequest("/api/v1/auth/reset-password", {
      token: "stale-token",
      new_password: "reset-new-password-1",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: { error: "invalid_token", message: "重置链接无效或已过期，请重新申请" },
    });
    expect(dbState.calls.some((call) => call.query.includes("UPDATE users SET password_hash"))).toBe(false);
  });

  it("缺 token → 422 validation_error: token is required", async () => {
    const res = await jsonRequest("/api/v1/auth/reset-password", {
      token: "   ",
      new_password: "reset-new-password-1",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ detail: "validation_error: token is required" });
  });

  it("新密码 < 8 → 422（先校验长度，不查 token）", async () => {
    resetDb(() => []);
    const res = await jsonRequest("/api/v1/auth/reset-password", {
      token: FIXTURE_TOKEN,
      new_password: "short",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: "validation_error: Password must be at least 8 characters",
    });
    expect(dbState.calls).toHaveLength(0);
  });
});
// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/auth/bootstrap-admin（main.py:313-350）
// ══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/auth/bootstrap-admin", () => {
  const SETUP_TOKEN = "admin-setup-token-xyz";
  const BODY = { email: "Admin@QA.test", password: "bootstrap-pass-1", display_name: "Sys Admin" };
  const bootEnv = (overrides: Record<string, unknown> = {}) =>
    makeTestEnv({ ADMIN_SETUP_TOKEN: SETUP_TOKEN, ...overrides });

  async function bootRequest(body: unknown, env = bootEnv(), authorization?: string): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authorization) headers.Authorization = authorization;
    return await app.request(
      "/api/v1/auth/bootstrap-admin",
      { method: "POST", headers, body: JSON.stringify(body) },
      env,
    );
  }

  it("成功：建 internal/system_admin、扁平 11 键、password_hash=$2b$12$、邮箱归一小写", async () => {
    resetDb((query) => {
      if (query.includes("account_type='internal'")) return [];
      if (query.includes("SELECT 1 FROM users WHERE email=")) return [];
      if (query.includes("INSERT INTO users")) {
        return [{
          id: 42, email: "admin@qa.test", display_name: "Sys Admin", account_type: "internal",
          role: "system_admin", plan: "internal", team_id: null, console_access: false,
        }];
      }
      return [];
    });

    const res = await bootRequest(BODY, bootEnv(), "Bearer " + SETUP_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "access_token", "account_type", "console_access", "display_name", "email",
      "plan", "role", "team_id", "team_name", "token_type", "user_id",
    ]);
    expect(body).toMatchObject({
      user_id: 42, email: "admin@qa.test", account_type: "internal",
      role: "system_admin", plan: "internal", team_id: null, team_name: null,
      console_access: false, token_type: "bearer",
    });
    const claims = decodeJwt(String(body.access_token)) as Record<string, unknown>;
    expect(claims.sub).toBe("42");

    const inserted = dbState.calls.find((call) => call.query.includes("INSERT INTO users"));
    expect(inserted, "应插入 users 行").toBeTruthy();
    // email 先 lower（main.py:340 / TS:body.email.toLowerCase()）
    expect(inserted!.params[0]).toBe("admin@qa.test");
    expect((inserted!.params[1] as string).startsWith(BCRYPT_COST12)).toBe(true);
    expect(await verifyPassword("bootstrap-pass-1", inserted!.params[1] as string)).toBe(true);
  });

  it("已初始化（存在 internal+system_admin）→ 403 System already initialized（幂等：第二次必失败）", async () => {
    resetDb((query) => (query.includes("account_type='internal'") ? [{ id: 1 }] : []));
    const res = await bootRequest(BODY, bootEnv(), "Bearer " + SETUP_TOKEN);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: "System already initialized" });
    expect(dbState.calls.some((call) => call.query.includes("INSERT INTO users"))).toBe(false);
  });

  it("邮箱已存在 → 409 conflict: Email already registered（不是 500 唯一约束）", async () => {
    resetDb((query) => {
      if (query.includes("account_type='internal'")) return [];
      if (query.includes("SELECT 1 FROM users WHERE email=")) return [{ "?column?": 1 }];
      return [];
    });
    const res = await bootRequest(BODY, bootEnv(), "Bearer " + SETUP_TOKEN);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: "conflict: Email already registered" });
  });

  it("缺 bearer → 401 Not authenticated（PARITY-DIFF-1）", async () => {
    const res = await bootRequest(BODY, bootEnv());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: "Not authenticated" });
  });

  it("setup token 错 → 403 Invalid setup token", async () => {
    const res = await bootRequest(BODY, bootEnv(), "Bearer wrong-setup-token-abc");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: "Invalid setup token" });
  });

  it("ADMIN_SETUP_TOKEN 未配 → 503（绝不回退默认值）", async () => {
    const res = await bootRequest(BODY, makeTestEnv(), "Bearer " + SETUP_TOKEN);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: "ADMIN_SETUP_TOKEN not configured" });
  });

  it("密码 < 8 → 422（PARITY-DIFF-2，在查库之前）", async () => {
    resetDb(() => []);
    const res = await bootRequest({ ...BODY, password: "short" }, bootEnv(), "Bearer " + SETUP_TOKEN);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: "validation_error: Password must be at least 8 characters",
    });
    expect(dbState.calls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/auth/register（main.py:819-1009）
// ══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/auth/register（契约抽查）", () => {
  const BASE = {
    email: "newbie@qa.test",
    password: "register-pass-1",
    display_name: "Newbie",
    product_category: "fencing",
  };

  it("product_category 非法 → 422（排序清单与 Python sorted(_CATEGORIES) 一致）", async () => {
    const res = await jsonRequest("/api/v1/auth/register", { ...BASE, product_category: "nope" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: string };
    expect(body.detail.startsWith("validation_error: product_category is required and must be one of: ")).toBe(true);
    expect(body.detail).toContain("fencing");
    expect(body.detail).toContain("wire_rope");
  });

  it("邀请码 / 新建团队 / 加入申请 三选一冲突 → 422 TEAM_ACTION_CONFLICT", async () => {
    const res = await jsonRequest("/api/v1/auth/register", {
      ...BASE,
      invite_token: "invite-1",
      team_name: "Acme",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "validation",
        code: "TEAM_ACTION_CONFLICT",
        detail: "只能三选一：凭邀请码加入现有团队、新建一个团队、或向已存在团队发起加入申请",
      },
    });
  });

  it("未知工位 → 422 UNKNOWN_WORKSTATION（解析期校验，即使不建团队）", async () => {
    const res = await jsonRequest("/api/v1/auth/register", { ...BASE, workstations: ["bogus_ws"] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: { code: string } };
    expect(body.detail.code).toBe("UNKNOWN_WORKSTATION");
  });

  it("成功（不建团队）：customer/free/owner、无 team、扁平响应 + token", async () => {
    resetDb((query) => {
      if (query.includes("SELECT 1 FROM users WHERE email=")) return [];
      if (query.includes("INSERT INTO users")) {
        return [{
          id: 77, email: "newbie@qa.test", display_name: "Newbie",
          account_type: "customer", role: "owner", status: "active",
        }];
      }
      return [];
    });

    const res = await jsonRequest("/api/v1/auth/register", BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      user_id: 77,
      email: "newbie@qa.test",
      display_name: "Newbie",
      account_type: "customer",
      role: "owner",
      plan: "free",
      team_id: null,
      team_name: null,
      application: null,
      console_access: false,
      token_type: "bearer",
    });
    const claims = decodeJwt(String(body.access_token)) as Record<string, unknown>;
    expect(claims.sub).toBe("77");

    const inserted = dbState.calls.find((call) => call.query.includes("INSERT INTO users"));
    expect(inserted, "应插入 users 行").toBeTruthy();
    // 反伪造：account_type/plan 由服务端写死（Python main.py:930-935）
    expect(inserted!.query).toContain("'customer'");
    expect(inserted!.query).toContain("'free'");
    expect(inserted!.params[0]).toBe("newbie@qa.test");
    expect(inserted!.params[2]).toBe("Newbie");
    expect(inserted!.params[3]).toBe("owner");
    expect((inserted!.params[1] as string).startsWith(BCRYPT_COST12)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// P1 硬指标：认证域全程不触达 Python 内核（KERNEL.fetch 0 次）
// ══════════════════════════════════════════════════════════════════════════════

describe("P1 直连：9 条认证路由不调用 KERNEL.fetch", () => {
  /**
   * auth 域与 P0 热读的差别（2026-10-24 事实核对）：
   * 9 条 auth 路由在 phase 2 波 a 就已直连 DB，**从未接过 AUTH_DB_SPLIT 开关**；
   * 因此开关任意取值都必须 0 次内核调用。若将来把它接进开关，off 分支必须
   * 显式走 forwardKernelRequest，并同步本用例（见 P1 交付说明）。
   */
  function kernelSpyEnv(flag: Record<string, unknown> = {}) {
    const fetch = vi.fn(async () => {
      throw new Error("KERNEL.fetch must not be called on P1 auth path");
    });
    return { fetch, env: makeTestEnv({ KERNEL: { fetch: fetch as never }, ...flag }) };
  }

  async function exerciseAllNine(env: typeof TEST_ENV): Promise<void> {
    const token = await createToken(ME_ROW.id, FIXED_SECRET);
    resetDb((query) => {
      if (query.includes("SELECT id, email, password_hash, display_name")) return [LOGIN_ROW];
      if (query.includes("UPDATE users SET display_name")) return [ME_ROW];
      if (query.includes("FROM users WHERE id")) return [ME_ROW];
      if (query.includes("FROM teams WHERE id")) return [{ name: "Acme Team" }];
      return [];
    });
    // 1) login
    expect((await jsonRequest("/api/v1/auth/login", { email: LOGIN_ROW.email, password: TEST_PASSWORD }, env)).status).toBe(200);
    // 2) me
    expect((await getRequest("/api/v1/auth/me", env, token)).status).toBe(200);
    // 3) logout
    expect((await jsonRequest("/api/v1/auth/logout", {}, env)).status).toBe(200);
    // 4) change-password（422 短路，不查密码）
    expect((await jsonRequest("/api/v1/auth/change-password", { current_password: "x", new_password: "short" }, env, token)).status).toBe(422);
    // 5) forgot-password（未知邮箱不落库不发信）
    expect((await jsonRequest("/api/v1/auth/forgot-password", { email: "none@qa.test" }, env)).status).toBe(200);
    // 6) reset-password（无效 token）
    expect((await jsonRequest("/api/v1/auth/reset-password", { token: "stale", new_password: "reset-pass-1" }, env)).status).toBe(400);
    // 7) register（参数非法短路）
    expect((await jsonRequest("/api/v1/auth/register", { email: "a@b.c", password: "12345678", display_name: "A", product_category: "nope" }, env)).status).toBe(422);
    // 8) bootstrap-admin（未配 token 短路）
    expect((await jsonRequest("/api/v1/auth/bootstrap-admin", { email: "a@b.c", password: "12345678", display_name: "A" }, env)).status).toBe(503);
    // 9) PATCH /auth/me（改显示名）
    expect((await app.request("/api/v1/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ display_name: "Buyer 2" }),
    }, env)).status).toBe(200);
  }

  it("AUTH_DB_SPLIT=on + 白名单 auth：0 次 KERNEL.fetch", async () => {
    const { fetch, env } = kernelSpyEnv({ AUTH_DB_SPLIT: "on", AUTH_DB_SPLIT_ROUTES: "auth" });
    await exerciseAllNine(env);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("AUTH_DB_SPLIT=off（回退态）：auth 仍直连 DB、0 次 KERNEL.fetch（不把登录绑回 Pyodide）", async () => {
    const { fetch, env } = kernelSpyEnv({ AUTH_DB_SPLIT: "off" });
    await exerciseAllNine(env);
    expect(fetch).not.toHaveBeenCalled();
  });
});
// ══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/auth/me（main.py:465-494）：profile 形状必须带 team_name
// ══════════════════════════════════════════════════════════════════════════════

describe("PATCH /api/v1/auth/me", () => {
  async function patchMe(body: unknown, handler: (q: string) => Record<string, unknown>[]): Promise<Response> {
    resetDb(handler);
    const token = await createToken(ME_ROW.id, FIXED_SECRET);
    return await app.request("/api/v1/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body),
    }, TEST_ENV);
  }

  it("成功：与 GET /auth/me 同形（user_id/effective_role/tenant_id/team_name）", async () => {
    const res = await patchMe({ display_name: "  Buyer Two  " }, (query) => {
      if (query.includes("UPDATE users SET display_name")) {
        return [{ ...ME_ROW, display_name: "Buyer Two" }];
      }
      if (query.includes("FROM users WHERE id")) return [ME_ROW];
      if (query.includes("FROM teams WHERE id")) return [{ name: "Acme Team" }];
      return [];
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: ME_ROW.id,
      user_id: ME_ROW.id,
      display_name: "Buyer Two",
      team_id: 9,
      team_name: "Acme Team", // main.py:492-494：_profile_payload 之后再补
      plan: "free",
      effective_role: "customer_owner",
      tenant_id: "default",
    });
    // display_name 先 strip 再落库（main.py:469）
    const update = dbState.calls.find((call) => call.query.includes("UPDATE users SET display_name"));
    expect(update!.params[0]).toBe("Buyer Two");
  });

  it("空显示名 → 422 DISPLAY_NAME_REQUIRED；超 64 字 → 422 DISPLAY_NAME_TOO_LONG", async () => {
    const empty = await patchMe({ display_name: "   " }, (q) => (q.includes("FROM users WHERE id") ? [ME_ROW] : []));
    expect(empty.status).toBe(422);
    expect(await empty.json()).toEqual({
      detail: { error: "validation", code: "DISPLAY_NAME_REQUIRED", detail: "显示名不能为空" },
    });

    const tooLong = await patchMe({ display_name: "x".repeat(65) }, (q) => (q.includes("FROM users WHERE id") ? [ME_ROW] : []));
    expect(tooLong.status).toBe(422);
    expect(await tooLong.json()).toEqual({
      detail: { error: "validation", code: "DISPLAY_NAME_TOO_LONG", detail: "显示名最长 64 个字符" },
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// plan 回落口径（Python 用 or "free"，不是 ?? "free"）
// ══════════════════════════════════════════════════════════════════════════════

describe("plan 回落：空串与 null 一样回落 free", () => {
  it("登录：DB plan 为空串 → 响应 plan=free（main.py:396）", async () => {
    resetDb((query) => {
      if (query.includes("FROM users WHERE email=")) return [{ ...LOGIN_ROW, plan: "" }];
      if (query.includes("FROM teams WHERE id")) return [{ name: "Acme Team" }];
      return [];
    });
    const res = await jsonRequest("/api/v1/auth/login", {
      email: LOGIN_ROW.email,
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).plan).toBe("free");
  });
});



