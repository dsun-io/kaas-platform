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
 * 错误形状（门面侧约定，调用方不再分辨来源）：
 * - **内核返回 5xx / 绑定未配置**：KernelError ⇒ HTTP { "error": "kernel_error", "message", "status" }；
 * - **fetch 抛错/无响应（冷启动期）**：按幂等性重试后仍失败才抛 KernelError(503)；
 *   HTTP 门面（proxy.ts）会把它转成 502 { "error": "kernel_unavailable", ..., "retryable": true }
 *   —— 与业务 5xx 区分，便于前端「等一会重试」与运维判因。
 *
 * 重试策略在本文件（KERNEL_RETRY_* / fetchKernelWithRetry）：callKernel 与 proxy.ts
 * 共用同一份实现，避免「两条路径两种窗口」。
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

// ── 内核冷启动重试策略（2026-10-24 生产事故：Pyodide `NoGilError` 偶发 init 失败）──
/**
 * 事故链路：内核新 isolate 冷启动偶发失败 ⇒ `env.KERNEL.fetch` **直接 reject**（没有任何
 * 响应）⇒ 旧实现 3 次 ×150ms 固定退避，总窗口 <0.5s，实测打不过 1–3s 的 Python 冷启动
 * ⇒ 一次页面加载 10+ 个透传请求全部 502。因此这里改成「按幂等性给足预算」。
 *
 * 重试边界（与 EXECUTION_PLAYBOOK §2 的分工）：
 * - **只有 fetch 抛错/无响应才重试**——内核已返回响应就说明请求可能已进入内核、可能已产生
 *   副作用，一律不重试；内核返回的 5xx 仍归一为 kernel_error（形状与语义都不变）。
 * - 幂等方法（读操作，无副作用）用完整退避序列 200/500/1200/2500ms（±20% 抖动），
 *   累计 ≈4.4s——这个量级才真正覆盖 Python/Pyodide 1–3s 冷启动。
 * - 非幂等方法（POST/PUT/PATCH/DELETE，可能已落库/发消息）**至多 1 次重试**，且必须
 *   body 可确定性重建（字符串/无 body）；流式 body 绝不重试（重放空 body = 制造假请求）。
 * - 抖动是必需的：同一页面会并发 10+ 个透传请求，同步退避会让它们在同一毫秒一起重试，
 *   正好再打一次正在冷启动的内核。
 */
export const KERNEL_RETRY_BACKOFF_MS: readonly number[] = [200, 500, 1200, 2500];
/** 退避抖动比例（±20%）。 */
export const KERNEL_RETRY_JITTER_RATIO = 0.2;
/** 幂等方法：无副作用，可安全重放（含 CORS 预检）。其余方法一律按非幂等处理（保守）。 */
export const KERNEL_RETRY_IDEMPOTENT_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS"];
/**
 * 非幂等方法的单次重试退避（ms）：只可能在「Service Binding 明确没把请求交给内核」时命中；
 * 等太久没有收益（首发是否已执行与等待时长无关），取最短退避以缩小
 * 「首发其实已成功、重放造成重复副作用」的窗口。
 */
export const KERNEL_RETRY_NON_IDEMPOTENT_BACKOFF_MS = 200;

export interface KernelRetryPlan {
  /** 总尝试次数（1 = 不重试）。 */
  maxAttempts: number;
  /** 各次重试前的基准退避；长度恒为 maxAttempts - 1。 */
  backoffMs: readonly number[];
}

/** 按「方法幂等性 + body 可否重放」决定重试预算（纯函数，测试直接覆盖）。 */
export function planKernelRetry(method: string, bodyReplayable: boolean): KernelRetryPlan {
  if (KERNEL_RETRY_IDEMPOTENT_METHODS.includes(method.toUpperCase())) {
    return {
      maxAttempts: KERNEL_RETRY_BACKOFF_MS.length + 1,
      backoffMs: KERNEL_RETRY_BACKOFF_MS,
    };
  }
  if (!bodyReplayable) return { maxAttempts: 1, backoffMs: [] };
  return { maxAttempts: 2, backoffMs: [KERNEL_RETRY_NON_IDEMPOTENT_BACKOFF_MS] };
}

/** 单次退避 = 基准 ±KERNEL_RETRY_JITTER_RATIO 抖动（毫秒取整、恒非负）。 */
export function jitteredBackoffMs(baseMs: number, random: () => number = Math.random): number {
  const span = baseMs * KERNEL_RETRY_JITTER_RATIO;
  return Math.max(0, Math.round(baseMs + (random() * 2 - 1) * span));
}

/** 重试器的可注入依赖（生产走默认实现；测试注入 sleep/random/now 以免真等 4.4s）。 */
export interface KernelRetryHooks {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface KernelFetchAttemptResult {
  /** 拿到的响应；null = 重试耗尽仍不可达。 */
  response: Response | null;
  /** 实际尝试次数。 */
  attempts: number;
  /** 最后一次抛错（拿不到响应时诊断用）。 */
  lastError: unknown;
  /** 从首发到结束的墙钟耗时（ms）。 */
  elapsedMs: number;
}

/**
 * 按 plan 调用 `kernel.fetch`：**只重试抛错**，拿到响应立即返回。
 * `makeRequest(attempt)` 负责构造每次尝试的 Request（body 重放由调用方负责）。
 */
export async function fetchKernelWithRetry(
  kernel: KernelCaller,
  plan: KernelRetryPlan,
  makeRequest: (attempt: number) => Request,
  hooks: KernelRetryHooks = {},
): Promise<KernelFetchAttemptResult> {
  const sleep =
    hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = hooks.random ?? Math.random;
  const now = hooks.now ?? Date.now;
  const startedAt = now();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= plan.maxAttempts; attempt += 1) {
    try {
      const response = await kernel.fetch(makeRequest(attempt));
      return { response, attempts: attempt, lastError: null, elapsedMs: now() - startedAt };
    } catch (err) {
      lastError = err;
      if (attempt >= plan.maxAttempts) break;
      const delayMs = jitteredBackoffMs(plan.backoffMs[attempt - 1] ?? 0, random);
      console.warn(
        `[kernel] fetch failed (attempt ${attempt}/${plan.maxAttempts}), retrying in ${delayMs}ms: ${String(err)}`,
      );
      await sleep(delayMs);
    }
  }

  return { response: null, attempts: plan.maxAttempts, lastError, elapsedMs: now() - startedAt };
}

/**
 * body 能否在重试时确定性重建。保守口径：只有「无 body」与「字符串 body」算可重放；
 * 流/FormData/Blob 等一次性或依赖内部状态的 body 一律不重试（宁可 502 也不发假请求）。
 */
export function isReplayableBody(body: BodyInit | null | undefined): boolean {
  return body === null || body === undefined || typeof body === "string";
}

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
  // 与 proxy.ts 共用同一份冷启动重试策略（见上方 KERNEL_RETRY_*）：
  // 只对 fetch 抛错重试；幂等方法给足 ≈4.4s 窗口，非幂等至多 1 次且 body 必须可重放。
  const plan = planKernelRetry(method, isReplayableBody(options.body));
  const result = await fetchKernelWithRetry(kernel, plan, () =>
    new Request(url, {
      method,
      headers: options.headers,
      body: options.body ?? null,
    }),
  );
  if (!result.response) {
    throw new KernelError(
      `kernel unreachable: ${result.lastError instanceof Error ? result.lastError.message : String(result.lastError)}`,
      503,
    );
  }
  if (result.response.status >= 500) {
    throw new KernelError(`kernel returned ${result.response.status}`, result.response.status);
  }
  return result.response;
}
