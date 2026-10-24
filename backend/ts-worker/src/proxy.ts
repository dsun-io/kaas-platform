/**
 * 内核透传层（quotes / trade-docs / ai 等引擎域 + 显式注册的逐端点透传路由）。
 *
 * 铁纪律（AGENTS.md 口径区 + ADR-008）：
 * - 不逐端点重写引擎域（禁止第二份实现）；本层只做三件事：
 *   ① 复用门面鉴权（JWT 校验，防御纵深）；② 原样转发请求；③ 错误信封归一。
 * - 禁止改写业务语义：不压缩/重试/换参数；4xx 原样透传，5xx/不可达统一包成
 *   { error: "kernel_error", message, status }（见 docs/EXECUTION_PLAYBOOK §2）。
 * - 鉴权策略：token 存在则校验（非法 token 直接 401，与 Python envelope 一致）；
 *   token 缺失则原样转发由内核裁决（保持与 Python 端点行为一致——有些端点公开放行）。
 * - **全门面只有这一份透传实现**：createProxyApp 的 app.all("*")（前缀 mount）与
 *   显式注册的逐端点路由（approvals / notifications / inquiries 等）都调
 *   forwardKernelRequest，禁止再复制一份（历史重复：intel.ts / workstations.ts 曾各有一份）。
 */
import { Hono, type Context } from "hono";
import { SignJWT } from "jose";

import type { ApiTokenActor, AppEnv } from "./actor";
import { extractBearer, JWT_ALGORITHM, verifyToken } from "./auth";
import { getEnv } from "./env";
import { KERNEL_BASE } from "./kernel";
import { requireUser } from "./session";

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

function unauthorized(c: Context): Response {
  return c.json({ detail: { error: "unauthorized", code: "INVALID_TOKEN" } }, 401);
}

/**
 * 原样转发当前请求给 Python 内核（**门面唯一透传实现**）。
 *
 * 语义（proxy mount 与显式透传路由完全一致）：
 * - 无 API token 身份时：JWT 存在则校验（非法 → 401，不触达内核）；缺失交给内核裁决；
 * - 有 API token 身份时：铸短时效内部 JWT 替换 Authorization（kaas_oat_ 明文绝不外传）；
 * - 方法 / path / query / body / 其余头原样；基址固定 KERNEL_BASE（Service Binding 忽略 host）；
 * - 2xx / 4xx 原样透传（形状由内核契约定）；5xx / 不可达归一为 kernel_error；
 * - CORS 头由 index.ts 外层中间件统一补。
 */
export async function forwardKernelRequest(c: Context): Promise<Response> {
  const env = getEnv(c);
  const secret = env.JWT_SECRET;
  const apiTokenActor = c.get("apiTokenActor") as ApiTokenActor | undefined;

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

  const headers = new Headers(c.req.raw.headers);
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
    headers.set("Authorization", `Bearer ${internalJwt}`);
  }

  // 基址固定 kernel.internal；path/query/method/body 原样。
  const url = new URL(c.req.url);
  const method = c.req.method;
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  const hasBody = method !== "GET" && method !== "HEAD" && c.req.raw.body !== null;
  if (hasBody) {
    // Workers/undici：流式 body 必须显式声明半双工（Node 测试环境要求，Workers 忽略该字段）。
    init.body = c.req.raw.body;
    init.duplex = "half";
  }

  const target = KERNEL_BASE + url.pathname + url.search;
  let upstream: Response | null = null;
  let lastErr: unknown = null;

  // ── 内核冷启动容错（2026-10-24 生产事故）──────────────────────────────
  // 现象：内核每次部署后，新版本 isolate 的第一批冷启动偶发
  // scriptThrewException / exceededResources（Cloudflare 侧 Python 启动失败），
  // Service Binding 的 fetch 直接 reject ⇒ 门面 502「kernel unreachable」。
  // 用户侧表现 = 部署后第一下「上传产品图 / 通知计数 / 报价下拉」就报错，刷新/重试即可。
  // 这里仅对 **fetch 抛错**（没拿到任何响应）做有限重试；内核已返回的 5xx 一律不重试
  // （请求可能已产生副作用）。有 body 的请求先 clone 一份用于重试（1 次；
  // GET/HEAD 等无 body 可安全重试 2 次）。上传类 POST 的落库按 sha256 定键，重试不产生重复对象。
  const KERNEL_FETCH_MAX_ATTEMPTS = 3;
  const KERNEL_FETCH_BACKOFF_MS = 150;
  const firstRequest = new Request(target, init);
  let replayRequest: Request | null = null;
  if (hasBody) {
    try {
      replayRequest = firstRequest.clone();
    } catch {
      replayRequest = null; // 某些运行时不允许 clone 流式 body ⇒ 退化为不重试
    }
  }
  const maxAttempts = hasBody ? (replayRequest ? 2 : 1) : KERNEL_FETCH_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outgoing =
      attempt === 1
        ? firstRequest
        : hasBody
          ? replayRequest!
          : new Request(target, init);
    try {
      upstream = await kernel.fetch(outgoing);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      console.warn(
        `[proxy] kernel fetch failed (attempt ${attempt}/${maxAttempts}), retrying: ${String(err)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, KERNEL_FETCH_BACKOFF_MS * attempt));
    }
  }

  if (!upstream) {
    console.error("[proxy] kernel fetch failed after retries", lastErr);
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
}

/**
 * 显式注册端点（逐条 method+path 注册的透传路由）用的入口：
 * 先做门面鉴权（JWT / API token），再原样转发内核。
 *
 * 与 proxy mount 的唯一区别就是这一步：这些端点在 routes.json 里都是 auth=true
 * （内核 depends=_get_current_user），匿名请求应在门面直接 401，不打到内核。
 */
export async function forwardAuthenticatedKernelRequest(c: Context): Promise<Response> {
  await requireUser(c);
  return forwardKernelRequest(c);
}

export function createProxyApp(prefix: string): Hono<ProxyEnv> {
  const app = new Hono<ProxyEnv>();

  // app.all("*") 挂载（OpenAPI 生成器据此识别透传 mount）；实现与显式路由共用一份。
  app.all("*", (c) => forwardKernelRequest(c));

  return app;
}
