/**
 * KaaS TS 门面 · 会话原语（对齐 Python main.py:_get_current_user / _create_token /
 * _hash_password / _auth_payload / _profile_payload）。
 *
 * 协议层本职：JWT 签发与校验、bcrypt 哈希、当前用户装载。
 * 业务规则（角色映射 effective_role 等）在 rules.ts 镜像，TODO(TODO:TS3) 换 KERNEL。
 */
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import type { Context } from "hono";

import type { ApiTokenActor } from "./actor";
import { verifyToken } from "./auth";
import { withDb, type Db } from "./db";
import { getEnv, requireSecret, type Env } from "./env";
import { httpError } from "./http";
import { effectiveRole } from "./rules";

/** bcrypt 哈希轮数对齐 Python bcrypt.gensalt() 默认（=12）。 */
export const BCRYPT_ROUNDS = 12;

/** 对齐 Python _hash_password（gensalt 默认 rounds=12，$2b$ 格式互通）。 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/** 对齐 Python _create_token：claims = {sub, iat, exp}，exp=+1440 分钟，HS256。 */
export async function createToken(userId: number | string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuedAt(now)
    .setExpirationTime(now + 1440 * 60)
    .sign(new TextEncoder().encode(secret));
}

export interface CurrentUser {
  id: number;
  email: string;
  display_name: string;
  account_type: string;
  role: string;
  status: string;
  team_id: number | null;
  console_access: boolean;
  plan: string | null;
  is_tenant_admin: boolean;
  [key: string]: unknown;
}

/** 认证失败 envelope（对齐 Python _decode_token / _get_current_user 的 401 detail）。 */
function unauthorized(message: string): never {
  throw httpError(401, { error: "unauthorized", message });
}

/** users 行 → CurrentUser（JWT 与 API token 两条路径共用，字段口径一致）。 */
function toCurrentUser(row: Record<string, unknown>): CurrentUser {
  return {
    id: Number(row.id),
    email: row.email as string,
    display_name: row.display_name as string,
    account_type: row.account_type as string,
    role: row.role as string,
    status: row.status as string,
    team_id: row.team_id === null || row.team_id === undefined ? null : Number(row.team_id),
    console_access: row.console_access === true,
    plan: (row.plan as string | null) ?? null,
    is_tenant_admin: row.is_tenant_admin === true,
  };
}

/**
 * API token 的会话用户（W5 M3 凭据转换）：
 * token 不是 JWT，但业务路由统一按“当前用户”写库/过滤。这里按 token.created_by
 * 装载创建人（与 KERNEL 内部 JWT 的 sub 同一人），并把 team_id 固定为 **token 签发时**
 * 的 team_id（团队隔离边界），而不是创建人当前所在团队。
 *
 * 边界：只在本请求已被全局 API token 中间件认证并校验 scope 后才会走到这里；
 * 普通 JWT 请求不会进入本函数，JWT 语义零改动。
 */
async function requireUserForApiToken(c: Context, actor: ApiTokenActor): Promise<CurrentUser> {
  const env = getEnv(c);
  const rows = await withDb(env, (sql: Db) => sql`
    SELECT id, email, display_name, account_type, role, status, team_id,
           console_access, plan, is_tenant_admin
      FROM users WHERE id = ${actor.createdBy}`);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || row.status !== "active") {
    unauthorized("User not found or disabled");
  }
  return {
    ...toCurrentUser(row),
    // token 的团队边界优先（token 签发后创建人换团队不扩权）
    team_id: actor.teamId,
  };
}

/**
 * 装载当前用户（对齐 Python _get_current_user）：
 * Bearer 提取 → JWT 校验 → users 行 → status 必须 active。
 * JWT_SECRET 缺失 → MissingSecretError（respond() 转 503）。
 *
 * W5 M3：若请求已由全局 API token 中间件认证（c.get("apiTokenActor")），
 * 则走 token 创建人 + token team_id 的等价用户装载；否则完全保持原 JWT 路径。
 */
export async function requireUser(c: Context): Promise<CurrentUser> {
  const apiTokenActor = c.get("apiTokenActor") as ApiTokenActor | undefined;
  if (apiTokenActor) {
    return requireUserForApiToken(c, apiTokenActor);
  }

  const env = getEnv(c);
  const authorization = c.req.header("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    unauthorized("Authentication required");
  }
  const secret = requireSecret(env, "JWT_SECRET");
  let payload;
  try {
    payload = await verifyToken(authorization.slice("Bearer ".length), secret);
  } catch (e) {
    if (e instanceof Error && e.message === "JWT_SECRET not configured") {
      // requireSecret 已兜住；这里对齐 verifyToken 的空 secret 防御
      throw e;
    }
    // exp 过期 / 签名非法 / 缺 sub：Python 侧统一 401 envelope
    unauthorized("Invalid or expired token");
  }
  const rows = await withDb(env, (sql: Db) => sql`
    SELECT id, email, display_name, account_type, role, status, team_id,
           console_access, plan, is_tenant_admin
      FROM users WHERE id = ${Number(payload.sub)}`);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || row.status !== "active") {
    unauthorized("User not found or disabled");
  }
  return toCurrentUser(row);
}

/** 团队名（Python _team_name_of；未加入团队 → null）。 */
export async function teamNameOf(env: Env, teamId: number | null): Promise<string | null> {
  if (teamId === null) return null;
  const rows = await withDb(env, (sql: Db) => sql`
    SELECT name FROM teams WHERE id = ${teamId}`);
  const row = rows[0] as { name: string } | undefined;
  return row?.name ?? null;
}

/** users 行（AuthPayload 来源）的宽松形状。 */
export interface AuthUserRow {
  id: number;
  email: string;
  display_name: string;
  account_type: string;
  role: string;
  plan?: string | null;
  team_id?: number | null;
  console_access?: boolean | null;
  [key: string]: unknown;
}

/**
 * 注册/登录/bootstrap-admin 共用的扁平账号响应（Python _auth_payload 逐键对齐）：
 * user_id / email / display_name / account_type / role / plan / team_id /
 * team_name / console_access / access_token / token_type。
 */
export function authPayload(row: AuthUserRow, token: string, teamName?: string | null): Record<string, unknown> {
  return {
    user_id: row.id,
    email: row.email,
    display_name: row.display_name,
    account_type: row.account_type,
    role: row.role,
    plan: row.plan ?? "free",
    team_id: row.team_id ?? null,
    team_name: teamName ?? null,
    console_access: row.console_access === true,
    access_token: token,
    token_type: "bearer",
  };
}

/** GET /auth/me 与 PATCH /auth/me 的响应组装（Python get_me / _profile_payload）。 */
export function profilePayload(user: CurrentUser, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...user,
    ...extra,
    user_id: user.id,
    plan: user.plan ?? "free",
    effective_role: effectiveRole(user.role),
    tenant_id: "default",
  };
}
