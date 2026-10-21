/**
 * KaaS TS 门面 · API token 管理域（W5 M1；3 条路由）。
 *
 * 设计 = docs/W5_MCP_REST_DESIGN_2026-10-21.md §2「管理入口」。
 *
 * ⚠️ 本文件**只接受 JWT（requireUser）**：API token 不能创建/列举/吊销 token。
 * 原因：Bearer 头同时承载两种凭据，如果管理端点也走 resolveActor，一个只读
 * token 就能给自己铸造更高 scope 的新 token（自举提权）。
 *
 * 铁纪律：这里只做鉴权/参数校验/协议转换；scopes 只是鉴权元数据，不含业务规则。
 * 「新域无 pydantic 真源」：本域是 TS 门面自有能力（不是 Python 业务模型），
 * 请求体校验用 zod 手写在本路由内，不从 generated/schemas.ts 生成。
 */
import { Hono } from "hono";
import { z } from "zod";

import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import { httpError, num, parseBody, parseQuery, pyIso, respond } from "../http";
import { requireUser } from "../session";
import {
  API_TOKEN_SCOPES,
  isKnownApiTokenScope,
  mintApiToken,
} from "../tokens";

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_TENANT = "default";

type Row = Record<string, unknown>;

/** 创建请求体（zod 手写；expires_in_days 省略 = 不过期）。 */
const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.string()).default([]),
  expires_in_days: z.number().int().positive().max(3650).optional(),
});

/** 路径参数 :id（FastAPI 风格：非法整数应 422 而不是 404）。 */
const tokenIdParam = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * 输出投影：**永远不含 token_hash / plaintext**。
 * 明文只在 POST 创建响应里出现一次。
 */
function tokenOut(row: Row): Record<string, unknown> {
  return {
    id: num(row.id),
    name: row.name,
    prefix: row.prefix,
    scopes: Array.isArray(row.scopes) ? row.scopes.map((value) => String(value)) : [],
    created_at: pyIso(row.created_at),
    last_used_at: pyIso(row.last_used_at),
    expires_at: pyIso(row.expires_at),
    revoked_at: pyIso(row.revoked_at),
  };
}

// GET /api/v1/api-tokens（JWT-only；M1 管理面按 created_by 隔离）
app.get("/api/v1/api-tokens", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const rows = await withDb(getEnv(c), (sql: Db) => sql`
    SELECT id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at
      FROM api_tokens
     WHERE tenant_id = ${DEFAULT_TENANT} AND created_by = ${user.id}
     ORDER BY id DESC`);
  const items = (rows as Row[]).map(tokenOut);
  return c.json({ items, total: items.length });
}));

// POST /api/v1/api-tokens（JWT-only；201，响应含一次性 plaintext）
app.post("/api/v1/api-tokens", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, createTokenSchema);

  // 去重后逐项对白名单；未知 scope → 422（发明文之外的 scope 一律拒绝）
  const scopes = [...new Set(body.scopes)];
  const unknown = scopes.filter((scope) => !isKnownApiTokenScope(scope));
  if (unknown.length > 0) {
    throw httpError(422, {
      error: "validation",
      code: "UNKNOWN_SCOPE",
      message: `未知 scope：${unknown.join(", ")}；可选：${API_TOKEN_SCOPES.join(", ")}`,
    });
  }

  const minted = mintApiToken();
  const expiresAt = body.expires_in_days === undefined
    ? null
    : new Date(Date.now() + body.expires_in_days * 24 * 60 * 60 * 1000);

  const rows = await withDb(getEnv(c), (sql: Db) => sql`
    INSERT INTO api_tokens
      (tenant_id, team_id, name, scopes, token_hash, prefix, created_by, expires_at)
    VALUES
      (${DEFAULT_TENANT}, ${user.team_id}, ${body.name}, ${scopes},
       ${minted.tokenHash}, ${minted.prefix}, ${user.id}, ${expiresAt})
    RETURNING id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at`);
  const row = (rows as Row[])[0];
  if (!row) {
    throw new Error("api_tokens INSERT returned no row");
  }
  return c.json({ ...tokenOut(row), plaintext: minted.plaintext }, 201);
}));

// DELETE /api/v1/api-tokens/{id}（JWT-only；软撤销 revoked_at=now()，重复撤销 409）
app.delete("/api/v1/api-tokens/:id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { id } = parseQuery(tokenIdParam, c.req.param(), "path");

  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const revoked = await sql`
      UPDATE api_tokens SET revoked_at = now()
       WHERE id = ${id}
         AND tenant_id = ${DEFAULT_TENANT}
         AND created_by = ${user.id}
         AND revoked_at IS NULL
      RETURNING id, revoked_at`;
    const row = (revoked as Row[])[0];
    if (row) {
      return { revoked: true, id: num(row.id), revoked_at: pyIso(row.revoked_at) };
    }

    // 区分「不存在 / 非本人」与「已撤销」：前者 404（不泄露存在性），后者 409
    const existing = await sql`
      SELECT id, revoked_at FROM api_tokens
       WHERE id = ${id}
         AND tenant_id = ${DEFAULT_TENANT}
         AND created_by = ${user.id}`;
    if ((existing as Row[]).length === 0) {
      throw httpError(404, { error: "not_found", code: "TOKEN_NOT_FOUND" });
    }
    throw httpError(409, { error: "conflict", code: "TOKEN_ALREADY_REVOKED" });
  });

  return c.json(payload);
}));

export default app;
