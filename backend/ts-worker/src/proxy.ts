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

import { extractBearer, verifyToken } from "./auth";
import { getEnv, type Env } from "./env";

export type ProxyEnv = { Bindings: Env };

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
    if (secret) {
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

    // 原样转发（内核处理 /api/* 前缀；URL/方法/头/body 保持不变）
    let upstream: Response;
    try {
      upstream = await kernel.fetch(c.req.raw);
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
