/**
 * 内核透传层（quotes / trade-docs / ai 三个引擎域）。
 *
 * 铁纪律（AGENTS.md 口径区 + ADR-008）：
 * - 不逐端点重写引擎域（禁止第二份实现）；本层只做三件事：
 *   ① 复用门面鉴权（JWT 校验，防御纵深）；② 原样转发请求；③ 错误信封归一。
 * - 禁止改写业务语义：不压缩/重试/换参数；4xx 原样透传，5xx/不可达统一包成
 *   { error: "kernel_error", message, status }（见 docs/EXECUTION_PLAYBOOK §2）。
 * - 鉴权策略：token 存在则校验（非法 token 直接 401，与 Python envelope 一致）；
 *   token 缺失则原样转发由内核裁决（保持与 Python 端点行为一致——有些端点公开放行）。
 */
import { Hono, type Context } from "hono";
import { SignJWT } from "jose";

import type { ApiTokenActor, AppEnv } from "./actor";
import { extractBearer, JWT_ALGORITHM, verifyToken } from "./auth";
import { getEnv } from "./env";

export type ProxyEnv = AppEnv;

/** 内部 JWT 有效期（设计 §3/§4：短时效凭据转换，exp ≤ 60s）。 */
export const INTERNAL_JWT_TTL_SECONDS = 60;

/**
 * 把 API token 身份铸成**短时效内部 JWT**（W5 M3 凭据转换，不是业务逻辑）：
 * - sub = token.created_by（KERNEL 的 _get_current_user 按 users.id 查）；
 * - team_id / tenant_id / token_id / scope 作为附加 claims 一并带上（内核当前只消费 sub，
 *   但这些 claims 让审计/后续内核改造能识别“这是 token 代用户调用”）；
 * - 用门面与内核共享的 JWT_SECRET + HS256 签名，exp = now + 60s；
 * - **不把 kaas_oat_ 明文转发给 KERNEL**（token 只应存在于门面与调用方之间）。
 */
export async function mintInternalJwt(
  actor: Pick<ApiTokenActor, "createdBy" | "tenantId" | "teamId" | "tokenId" | "scopes">,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tenant_id: actor.tenantId,
    team_id: actor.teamId,
    created_by: actor.createdBy,
    token_id: actor.tokenId,
    scope: actor.scopes.join(" "),
  })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setSubject(String(actor.createdBy))
    .setIssuedAt(now)
    .setExpirationTime(now + INTERNAL_JWT_TTL_SECONDS)
    .sign(new TextEncoder().encode(secret));
}

/** 校验（仅当请求带 token）：非法 → invalid；合法 → ok；缺失 → absent（由内核裁决） */
export async function guardTokenIfPresent(
  token: string | null,
  secret: string,
): Promise<"ok" | "invalid" | "absent"> {
  if (!token) return "absent";
  try {
    await verifyToken(token, secret);
    return "ok";
  } catch {
    return "invalid";
  }
}

function unauthorized(c: Context<ProxyEnv>): Response {
  return c.json({ detail: { error: "unauthorized", code: "INVALID_TOKEN" } }, 401);
}

export function createProxyApp(prefix: string): Hono<ProxyEnv> {
  const app = new Hono<ProxyEnv>();

  app.all("*", async (c) => {
    const env = getEnv(c);
    const secret = env.JWT_SECRET;
    const apiTokenActor = c.get("apiTokenActor");

    // 无 API token 身份时保持原语义：JWT 有则验、缺失则交给内核裁决。
    // 有 API token 身份时不再按 JWT 校验（凭据已由全局 scope 中间件验过），
    // 改为下面的短时效内部 JWT 转换。
    if (!apiTokenActor && secret) {
      const token = extractBearer(c.req.header("Authorization") ?? null);
      const state = await guardTokenIfPresent(token, secret);
      if (state === "invalid") return unauthorized(c);
    }

    const kernel = env.KERNEL;
    if (!kernel) {
      return c.json(
        { error: "kernel_error", message: "kernel binding not configured", status: 503 },
        503,
      );
    }

    // 原样转发（内核处理 /api/* 前缀；URL/方法/body 保持不变）；
    // API token 请求只替换 Authorization 为内部 JWT，其余头/方法/路径/查询串原样。
    let upstreamRequest = c.req.raw;
    if (apiTokenActor) {
      if (!secret) {
        return c.json(
          { error: "kernel_error", message: "JWT_SECRET not configured", status: 503 },
          503,
        );
      }
      let internalJwt: string;
      try {
        internalJwt = await mintInternalJwt(apiTokenActor, secret);
      } catch (err) {
        console.error("[proxy] internal JWT mint failed", err);
        return c.json(
          { error: "kernel_error", message: "internal JWT mint failed", status: 500 },
          500,
        );
      }
      const headers = new Headers(c.req.raw.headers);
      headers.set("Authorization", `Bearer ${internalJwt}`);
      upstreamRequest = new Request(c.req.raw, { headers });
    }

    let upstream: Response;
    try {
      upstream = await kernel.fetch(upstreamRequest);
    } catch (err) {
      console.error("[proxy] kernel fetch failed", err);
      return c.json({ error: "kernel_error", message: "kernel unreachable", status: 502 }, 502);
    }

    if (upstream.status >= 500) {
      const text = await upstream.text();
      return c.json(
        { error: "kernel_error", message: text.slice(0, 500), status: upstream.status },
        upstream.status as 500,
      );
    }

    // 4xx / 2xx 原样透传（CORS 头由外层中间件统一补）
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  });

  return app;
}
