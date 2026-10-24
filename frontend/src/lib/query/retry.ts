/**
 * React Query 重试口径：**有限次、带退避、只重试值得重试的错误**。
 *
 * 背景（2026-10-24 产品页 502 事故）：后端内核（Python/Pyodide）冷启动会间歇 502，
 * 门面把它包成 `{ error: "kernel_unavailable", retryable: true }` + `Retry-After`；
 * 前端如果把每个失败请求都各弹一条 toast、各打一条 console.error，页面就会被
 * 「一次加载十条报错」刷屏。所以重试策略必须是**一份、有限、可解释**的：
 *
 * - 4xx（参数 / 权限 / 业务规则）是**确定性**失败，重试只会把后端打得更惨 ⇒ 不重试；
 * - 网络错误与 5xx 是**瞬时**失败 ⇒ 最多重试 2 次，退避 400ms / 1200ms；
 * - 门面若明确标注 `retryable: false`（内核**返回**的 5xx 是业务失败，不是「不可达」），
 *   不重试 —— 与门面契约对齐，**不靠 message 文案判断**；
 * - `Retry-After` 给得比退避长时按它等（上限 10s），避免冷启动窗口里猛打；
 * - 全站统一放在 provider 的 `defaultOptions`，页面不再各写一份。
 *
 * 与 `lib/api/client.ts` 的传输层重试是**两层**：axios 只对幂等请求（GET/HEAD）做
 * 3 次退避重试，写请求不重试。两层都有限次、都是指数退避，总量有界；
 * 查询层的这 2 次是**非 axios 查询**（fetch/XHR 直连）的唯一退避来源。
 */

/** 查询层最多重试次数（= 首次失败后再来 2 次）。 */
export const QUERY_RETRY_MAX = 2;

const RETRYABLE_STATUS_MIN = 500;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_GROWTH = 3;
const RETRY_MAX_DELAY_MS = 10_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

interface ErrorSurface {
  /** HTTP 状态码；没有响应（网络层失败）时为 null */
  status: number | null;
  /** 响应体（门面/内核的错误信封） */
  body: Record<string, unknown> | null;
  /** 响应头（axios 的 AxiosHeaders / 普通对象都认） */
  headers: unknown;
  hasResponse: boolean;
}

function readErrorSurface(error: unknown): ErrorSurface {
  const root = asRecord(error);
  const response = asRecord(root?.["response"]);
  const rawStatus = response?.["status"];
  return {
    status: typeof rawStatus === "number" ? rawStatus : null,
    body: asRecord(response?.["data"]),
    headers: response?.["headers"],
    hasResponse: response !== null,
  };
}

/** 读响应头：axios 的 AxiosHeaders 有 get()，普通对象 / Headers 也认。 */
function readHeader(headers: unknown, name: string): string | null {
  const holder = headers as { get?: (key: string) => unknown } | null;
  if (holder && typeof holder.get === "function") {
    const value = holder.get(name);
    return typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : null;
  }
  const plain = asRecord(headers);
  if (!plain) return null;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(plain)) {
    if (key.toLowerCase() === lower && typeof value === "string") {
      return value.trim() === "" ? null : value.trim();
    }
  }
  return null;
}

/** `Retry-After`（秒数或 HTTP 日期）→ 毫秒；没有/读不懂返回 null。 */
function retryAfterMs(headers: unknown): number | null {
  const raw = readHeader(headers, "retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

/**
 * 门面/内核约定 `retryable: false` = 业务失败（内核**返回**的 5xx），重试没有意义。
 * 注意：读的是结构字段，不是 message 文案 —— 文案会漂移，结构不会。
 */
function explicitlyNotRetryable(body: Record<string, unknown> | null): boolean {
  return body?.["retryable"] === false || body?.["retryable"] === "false";
}

/**
 * 值不值得重试：5xx / 网络错误 = 瞬时失败（可重试）；4xx = 确定性失败（不重试）。
 */
export function isRetryableApiError(error: unknown): boolean {
  const surface = readErrorSurface(error);
  // 断网 / 超时 / 连接被重置：没有响应体，是典型的瞬时失败
  if (!surface.hasResponse) return true;
  const { status, body } = surface;
  if (status === null) return true;
  if (status < RETRYABLE_STATUS_MIN) return false;
  return !explicitlyNotRetryable(body);
}

/** React Query 的 `retry` 回调：最多 2 次，且只重试瞬时失败。 */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  return failureCount < QUERY_RETRY_MAX && isRetryableApiError(error);
}

/**
 * React Query 的 `retryDelay` 回调：400ms → 1200ms → …，并尊重 `Retry-After`。
 *
 * 不加入随机抖动：本项目的重试量级是「页面级几个查询」，抖动带来的可测性损失
 * （测试要打桩随机数）大于收益；真正的风暴防护由「最多 2 次」和门面重试兜底。
 */
export function queryRetryDelay(failureCount: number, error: unknown): number {
  const backoff =
    RETRY_BASE_DELAY_MS * RETRY_GROWTH ** Math.max(0, failureCount);
  const hinted = retryAfterMs(readErrorSurface(error).headers) ?? 0;
  return Math.min(Math.max(backoff, hinted), RETRY_MAX_DELAY_MS);
}
