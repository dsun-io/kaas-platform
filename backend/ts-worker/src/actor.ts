/**
 * KaaS TS 门面 · 请求身份解析（JWT 会话 vs 对外 API token，W5 M1）。
 *
 * 设计（docs/W5_MCP_REST_DESIGN_2026-10-21.md §2）：
 *   同一个 `Authorization: Bearer <token>` 头：
 *   - 以 `kaas_oat_` 开头 → 查 api_tokens（哈希/未撤销/未过期），得到 token 身份；
 *   - 否则 → 走 JWT（requireUser 的现有语义：校验签名/exp + users 行 active）。
 *
 * 铁律：管理端点 /api/v1/api-tokens **只用 requireUser（JWT）**，不走本文件——
 * 否则一个 API token 可以给自己铸造新 token / 扩 scope（自举提权）。
 */
import type { Context } from "hono";

import { withDb, type Db } from "./db";
import { getEnv } from "./env";
import { httpError } from "./http";
import { requireUser, type CurrentUser } from "./session";
import { API_TOKEN_PREFIX, verifyApiToken } from "./tokens";

/** JWT 会话身份（用户行已由 requireUser 校验 active）。 */
export interface UserActor {
  kind: "user";
  user: CurrentUser;
  tenantId: "default";
  teamId: number | null;
  /** 会话用户没有 token scope；角色闸门由 requireUser/各域自己负责。 */
  scopes: null;
}

/** API token 身份：team_id 是数据隔离边界，scopes 是鉴权元数据。 */
export interface ApiTokenActor {
  kind: "api_token";
  tokenId: number;
  tenantId: string;
  teamId: number | null;
  scopes: string[];
  name: string;
}

export type Actor = UserActor | ApiTokenActor;

function unauthorized(message: string): never {
  throw httpError(401, { error: "unauthorized", message });
}

/**
 * 解析当前请求的 actor：
 * - 缺 Bearer → 401 "Authentication required"（对齐 requireUser）；
 * - `kaas_oat_` → API token 校验失败一律 401 "Invalid or expired token"；
 * - 其他 → JWT（requireUser：过期/签名非法/用户停用都是 401）。
 */
export async function resolveActor(c: Context): Promise<Actor> {
  const authorization = c.req.header("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    unauthorized("Authentication required");
  }
  const bearer = authorization.slice("Bearer ".length);

  if (bearer.startsWith(API_TOKEN_PREFIX)) {
    const env = getEnv(c);
    const record = await withDb(env, (sql: Db) => verifyApiToken(sql, bearer));
    if (!record) {
      // 未知 / 已撤销 / 已过期 不区分，避免给爆破方提供存在性信号
      unauthorized("Invalid or expired token");
    }
    return {
      kind: "api_token",
      tokenId: record.id,
      tenantId: record.tenantId,
      teamId: record.teamId,
      scopes: record.scopes,
      name: record.name,
    };
  }

  const user = await requireUser(c);
  return {
    kind: "user",
    user,
    tenantId: "default",
    teamId: user.team_id,
    scopes: null,
  };
}
