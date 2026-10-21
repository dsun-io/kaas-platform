/**
 * KaaS TS 门面 · 对外 API token 原语（W5 M1，设计见 docs/W5_MCP_REST_DESIGN_2026-10-21.md §2）。
 *
 * 职责边界（ADR-008）：
 * - 只做凭据的生成/散列/校验与 scope 匹配，不承载任何业务规则；
 * - scopes 只是**鉴权元数据**，业务语义（哪些工位/动作可做什么）由后续 MCP/REST 接线按需消费。
 *
 * 安全铁律：
 * - 明文形如 `kaas_oat_<32 字节 base64url>`，**只在创建响应出现一次**；
 * - 库里只存 sha256 hex（token_hash）与可识别前缀（prefix），不存明文、不入日志；
 * - 校验 SQL 用参数化查询（postgres.js tagged template），不做字符串拼接。
 */
import { createHash, randomBytes } from "node:crypto";

import type { Db } from "./db";

/** token 前缀（oat = outbound access token）。 */
export const API_TOKEN_PREFIX = "kaas_oat_";

/** 随机部分字节数（设计 §2：32 字节 base64url）。 */
export const API_TOKEN_RANDOM_BYTES = 32;

/** prefix 列保留的随机部分字符数（够 UI 区分，不泄露可用于爆破的信息）。 */
export const API_TOKEN_PREFIX_DISPLAY_CHARS = 8;

/**
 * M1 scope 白名单（设计 §2 示例 + 工位粒度）。
 *
 * 「新域无 pydantic 真源」：本域是 TS 门面自有的鉴权元数据，不是 Python 业务模型，
 * 因此不来自 generated/schemas.ts；扩 scope 只改这一处，禁止散落在路由里。
 */
export const API_TOKEN_SCOPES: readonly string[] = [
  "customers:read",
  "customers:write",
  "inquiries:read",
  "inquiries:write",
  "orders:read",
  "orders:write",
  "quotes:read",
  "quotes:calc",
  "trade_docs:read",
  "trade_docs:write",
  "shipments:read",
  "shipments:write",
  "leadgen:read",
  "leadgen:write",
  "outreach:read",
  "outreach:write",
  "research:read",
  "research:write",
  "intel:read",
  "files:read",
  "files:write",
];

const SCOPE_SET: ReadonlySet<string> = new Set(API_TOKEN_SCOPES);

/** 是否为白名单 scope（路由层用于 422 校验）。 */
export function isKnownApiTokenScope(scope: string): boolean {
  return SCOPE_SET.has(scope);
}

/** mint 结果：plaintext 只回给调用方一次；tokenHash/prefix 落库。 */
export interface MintedApiToken {
  plaintext: string;
  tokenHash: string;
  prefix: string;
}

/**
 * 生成 API token：`kaas_oat_` + 32 字节 base64url（43 字符，URL 安全、无填充）。
 * prefix = 前缀 + 随机部分前 8 字符（例：`kaas_oat_AbCdEf12`）。
 */
export function mintApiToken(): MintedApiToken {
  const random = randomBytes(API_TOKEN_RANDOM_BYTES).toString("base64url");
  const plaintext = `${API_TOKEN_PREFIX}${random}`;
  return {
    plaintext,
    tokenHash: hashApiToken(plaintext),
    prefix: plaintext.slice(0, API_TOKEN_PREFIX.length + API_TOKEN_PREFIX_DISPLAY_CHARS),
  };
}

/** sha256(plaintext) → 小写 hex（与库中 token_hash 同口径）。 */
export function hashApiToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** 校验成功后注入请求上下文的 token 身份（不含 hash/明文）。 */
export interface ApiTokenRecord {
  id: number;
  tenantId: string;
  teamId: number | null;
  scopes: string[];
  name: string;
}

/**
 * 校验 API token（设计 §2 鉴权中间件的数据层）：
 * 查 hash（未撤销、未过期）→ 更新 last_used_at → 返回身份；任一步不满足返回 null。
 *
 * 过期/撤销判断放进 SQL（而不是读回 JS 再比），保证只有一条有效行被命中；
 * 未知 token 与已撤销/已过期 token 对调用方**不可区分**（一律 401）。
 */
export async function verifyApiToken(
  sql: Db,
  plaintext: string,
): Promise<ApiTokenRecord | null> {
  // 非本前缀的凭据不查库（调用方应走 JWT；这里防御性返回 null）
  if (!plaintext.startsWith(API_TOKEN_PREFIX)) return null;

  const tokenHash = hashApiToken(plaintext);
  const rows = await sql`
    SELECT id, tenant_id, team_id, scopes, name
      FROM api_tokens
     WHERE token_hash = ${tokenHash}
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  const id = Number(row.id);
  await sql`UPDATE api_tokens SET last_used_at = now() WHERE id = ${id}`;

  return {
    id,
    tenantId: String(row.tenant_id),
    teamId: row.team_id === null || row.team_id === undefined ? null : Number(row.team_id),
    // fetch_types:false 时 text[] 可能回传 PG 字面量字符串（{a,b}），统一归一
    scopes: Array.isArray(row.scopes)
      ? row.scopes.map((value) => String(value))
      : String(row.scopes ?? "")
          .replace(/^\{|\}$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean),
    name: String(row.name),
  };
}

/**
 * scope 匹配（精确匹配，不做通配/层级推导）。
 * 只认 actor 上显式声明的 scopes；JWT 会话用户走 requireUser 的角色闸门，不在此处放宽。
 */
export function hasScope(
  actor: { scopes?: readonly string[] | null } | null | undefined,
  scope: string,
): boolean {
  if (!actor || !Array.isArray(actor.scopes)) return false;
  return actor.scopes.includes(scope);
}
