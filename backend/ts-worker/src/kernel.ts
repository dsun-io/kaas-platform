/**
 * KaaS TS 门面 · Python 内核 Service Binding 调用封装（ADR-008）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 契约纪律（AGENTS.md 铁纪律，逐字生效）：                                │
 * │ ① 业务规则只在 Python 内核一处实现；本封装**禁止承载任何业务 if**。        │
 * │ ② TS 门面只做鉴权/参数校验/协议转换——转发前已完成入参校验的，这里原样透传。   │
 * │ ③ 跨层契约变更必须同 PR + 金标 harness（backend/ts-migration/golden/） │
 * │    全绿；禁止单方面改请求/响应形状。                                    │
 * │ ④ 转发一律走 env.KERNEL.fetch（Service Binding，同账号 Worker 互调，    │
 * │    免费档可用，不计公网请求配额）；禁止绕过门面直连内核的公网域名。          │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 统一错误形状（门面侧约定，内核不可达/内核 5xx 一律包成它，调用方不再分辨来源）：
 *   { "error": "kernel_error", "message": <string>, "status": <http status> }
 */

export interface KernelErrorShape {
  error: "kernel_error";
  message: string;
  status: number;
}

export class KernelError extends Error implements KernelErrorShape {
  readonly error = "kernel_error" as const;
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "KernelError";
    this.status = status;
  }

  /** HTTP 响应体（直接 JSON.stringify 即可）。 */
  toJSON(): KernelErrorShape {
    return { error: this.error, message: this.message, status: this.status };
  }
}

export interface KernelCaller {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

/**
 * 内核内部基址（Service Binding 内 fetch 需要绝对 URL；host 段无意义但须合法）。
 * 门面透传统一用这个基址重建 URL（见 src/proxy.ts:forwardKernelRequest）：
 * Service Binding 按 path/query 派发，host 段不参与路由。
 */
export const KERNEL_BASE = "https://kernel.internal";

export interface CallKernelOptions {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
}

/**
 * 调用 Python 内核并返回其原始 Response（调用方负责按契约解析）。
 * 内核不可达（binding 异常）或返回 5xx 时抛 KernelError（统一错误形状）；
 * 4xx 原样透传（那是参数/鉴权问题，形状已由内核契约定）。
 */
export async function callKernel(
  kernel: KernelCaller,
  path: string,
  options: CallKernelOptions = {},
): Promise<Response> {
  const url = new URL(path, KERNEL_BASE);
  const method = options.method ?? "GET";
  // 内核冷启动容错（2026-10-24）：GET/HEAD 无副作用，对 Service Binding
  // 的 fetch 抛错（isolation 启动失败）做有限重试；有 body 的调用不重试。
  const maxAttempts = method === "GET" || method === "HEAD" ? 3 : 1;
  const backoffMs = 150;
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      res = await kernel.fetch(
        new Request(url, {
          method,
          headers: options.headers,
          body: options.body ?? null,
        }),
      );
      break;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      console.warn(
        `[kernel] fetch failed (attempt ${attempt}/${maxAttempts}), retrying: ${String(err)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
  if (!res) {
    throw new KernelError(
      `kernel unreachable: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      503,
    );
  }
  if (res.status >= 500) {
    throw new KernelError(`kernel returned ${res.status}`, res.status);
  }
  return res;
}
