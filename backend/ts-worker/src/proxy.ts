/**
 * 内核透传层（quotes / trade-docs / ai 等引擎域 + 显式注册的逐端点透传路由）。
 *
 * 铁纪律（AGENTS.md 口径区 + ADR-008）：
 * - 不逐端点重写引擎域（禁止第二份实现）；本层只做三件事：
 *   ① 复用门面鉴权（JWT 校验，防御纵深）；② 原样转发请求；③ 错误信封归一。
 * - 禁止改写业务语义：不压缩/换参数；4xx 原样透传，内核返回的 5xx 统一包成
 *   { error: "kernel_error", message, status }（见 docs/EXECUTION_PLAYBOOK §2）。
 * - 唯一例外：**内核冷启动期 fetch 抛错（拿不到任何响应）**按方法幂等性做有限次指数
 *   退避重试（策略与 callKernel 共用：见 kernel.ts 的 KERNEL_RETRY_*）；重试耗尽返回 502
 *   { error: "kernel_unavailable", message, status: 502, retryable: true, attempts, elapsed_ms }
 *   —— 与业务 5xx（kernel_error）分开，前端/运维一眼判断「不是业务失败、可以重试」。
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
import { fetchKernelWithRetry, KERNEL_BASE, planKernelRetry } from "./kernel";
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

/** 502 不可达信封：比 kernel_error 多出 retryable/attempts/elapsed_ms，便于前端与运维判断。 */
export interface KernelUnavailableEnvelope {
  error: "kernel_unavailable";
  message: string;
  status: 502;
  retryable: true;
  attempts: number;
  elapsed_ms: number;
}

/** 给用户看的兜底文案（不带内部错误串，诊断信息留在 console.error 与结构化字段）。 */
export const KERNEL_UNAVAILABLE_MESSAGE = "内核服务正在启动或暂时不可用，请稍后重试";
/** 建议客户端重试间隔（秒）：重试预算已在门面侧用完，别让前端立刻再打一轮。 */
export const KERNEL_UNAVAILABLE_RETRY_AFTER_SECONDS = 1;

/**
 * 原样转发当前请求给 Python 内核（**门面唯一透传实现**）。
 *
 * 语义（proxy mount 与显式透传路由完全一致）：
 * - 无 API token 身份时：JWT 存在则校验（非法 → 401，不触达内核）；缺失交给内核裁决；
 * - 有 API token 身份时：铸短时效内部 JWT 替换 Authorization（kaas_oat_ 明文绝不外传）；
 * - 方法 / path / query / body / 其余头原样；基址固定 KERNEL_BASE（Service Binding 忽略 host）；
 * - 2xx / 4xx 原样透传（形状由内核契约定）；内核返回的 5xx 归一为 kernel_error；
 * - fetch 抛错（无响应）按幂等性有限重试，耗尽后 502 kernel_unavailable（retryable）；
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
  // 首发只建一次 Request；有 body 时再 clone 一份专门用于有限次重放（流只能被消费一次）。
  const firstRequest = new Request(target, init);
  let replayRequest: Request | null = null;
  if (hasBody) {
    try {
      replayRequest = firstRequest.clone();
    } catch {
      replayRequest = null; // 运行时不允许 clone 流式 body ⇒ 非幂等请求退化为不重试
    }
  }
  const plan = planKernelRetry(method, !hasBody || replayRequest !== null);
  const result = await fetchKernelWithRetry(kernel, plan, (attempt) =>
    attempt === 1 ? firstRequest : replayRequest ?? new Request(target, init),
  );

  if (!result.response) {
    // 运维据此区分「冷启动抖动（可重试）」与「内核真的挂了」：方法/路径/尝试次数/耗时/
    // 最后一个错误全部进日志；响应体只保留安全字段（不把内部异常串甩给用户）。
    console.error(
      `[proxy] kernel_unavailable method=${method} path=${url.pathname} attempts=${result.attempts} elapsed_ms=${result.elapsedMs} last_error=${String(result.lastError)}`,
    );
    const envelope: KernelUnavailableEnvelope = {
      error: "kernel_unavailable",
      message: KERNEL_UNAVAILABLE_MESSAGE,
      status: 502,
      retryable: true,
      attempts: result.attempts,
      elapsed_ms: result.elapsedMs,
    };
    return c.json(envelope, 502, {
      "Retry-After": String(KERNEL_UNAVAILABLE_RETRY_AFTER_SECONDS),
    });
  }

  const upstream = result.response;

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
