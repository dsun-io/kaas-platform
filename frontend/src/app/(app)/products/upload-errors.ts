/**
 * 产品工位 · 上传/排序的**错误提示**口径（纯函数，页面级测试直接覆盖）。
 *
 * 为什么单独抽出来：
 * - 页面组件里的 `catch` 分支只做 `toast.error(...)`，文案口径却是可测的规则：
 *   后端/上传 hook 给的"可执行原因"要原样透出，而 axios 的通用文案
 *   （`Request failed with status code 422` / `Network Error`）对用户**没有信息量**，
 *   继续显示只会让人以为系统坏了。
 * - 排序的 `sort_order` 越界由后端 422 拒绝（`ws_files.py` `SORT_ORDER_OUT_OF_RANGE`，
 *   口径 0–9999），页面必须把"0 ~ 9999"这个可执行原因带给用户，而不是一句"排序失败"。
 */

export interface ApiErrorParts {
  /** HTTP 状态码（axios 有 response 时才有） */
  status?: number;
  /** 后端业务码（detail.code / detail.error_code） */
  code?: string;
  /** 最有信息量的一句话（后端 detail / 我方可执行文案）；通用 axios 文案会被过滤掉 */
  detail?: string;
}

const GENERIC_HTTP = /^Request failed with status code \d+$/;
const GENERIC_NETWORK = new Set([
  "Network Error",
  "Failed to fetch",
  "Load failed",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** 能不能拿给用户看：通用 HTTP/网络文案不算信息。 */
function usable(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (GENERIC_HTTP.test(text) || GENERIC_NETWORK.has(text)) return undefined;
  return text;
}

/**
 * 从 axios 错误里拆出「状态码 / 业务码 / 可执行说明」。
 *
 * 后端错误体有扁平（`{error_code,message}`）与嵌套（`{detail:{error,code,detail}}`）两种，
 * 这里都认（与 `lib/api/error-handler.ts` 的 `normalizeApiError` 同口径，但不依赖它：
 * 那个函数会 toast + 上报，测试里只想拿数据）。
 */
export function apiErrorParts(err: unknown): ApiErrorParts {
  const root = asRecord(err);
  const response = asRecord(root?.["response"]);
  const data = asRecord(response?.["data"]);
  const status =
    typeof response?.["status"] === "number"
      ? (response["status"] as number)
      : undefined;
  // 门面的错误信封用 `error` 当机器可读标识（`{ error: "kernel_unavailable", ... }`），
  // 路由层的 HTTPException 用 `code` / `error_code`；三种都认。
  // 注意：**只认结构字段，不认 message 文案** —— 文案会漂移，判断会跟着坏。
  const code =
    nonEmpty(data?.["code"]) ??
    nonEmpty(data?.["error_code"]) ??
    nonEmpty(data?.["error"]);

  const rawDetail = data?.["detail"];
  let detail = nonEmpty(rawDetail);
  if (!detail) {
    const nested = asRecord(rawDetail);
    detail =
      nonEmpty(nested?.["detail"]) ??
      nonEmpty(nested?.["message"]) ??
      nonEmpty(nested?.["code"]);
  }
  if (!detail) detail = nonEmpty(data?.["message"]);
  if (!detail) {
    // 我方 hook 抛的 Error（例如"字节已直传成功但登记失败，请重试"）比 axios 文案有用
    detail = usable(err instanceof Error ? err.message : undefined);
  }
  return { status, code, detail };
}

/**
 * 服务不可用（门面 `kernel_unavailable` / 502 / 503 / 504）的统一文案。
 *
 * 口径（2026-10-24 与门面 502 信封改造同步）：
 * - 这是**可恢复**的基础设施抖动（内核 Pyodide 冷启动失败），不是用户的文件有问题；
 * - 绝不能说「上传失败 / 图片损坏 / 格式不对」—— 用户会去重拍、重命名、换格式，白折腾；
 * - 说明「已自动重试」是给用户的信息：系统已经扛过了，不需要他自己找原因。
 */
export const SERVICE_UNAVAILABLE_MESSAGE =
  "服务暂时不可用（后台内核正在启动），已自动重试；请稍后点「重试」";

/**
 * 判断是不是「服务不可用」这一类（结构判断，不读 message 文案）。
 *
 * 门面契约：内核不可达 → 502 + `{ error: "kernel_unavailable", retryable: true }`
 * + `Retry-After`；`503/504` 同属可恢复。内核**返回**的 5xx 仍是业务失败
 * （`kernel_error`），不当成"服务不可用"。
 */
export function isServiceUnavailable(parts: ApiErrorParts): boolean {
  const { status, code } = parts;
  if (code === "kernel_unavailable" || code === "KERNEL_UNAVAILABLE")
    return true;
  return status === 502 || status === 503 || status === 504;
}

/**
 * 上传失败提示。
 *
 * 优先级：服务不可用（可恢复，别怪文件）→ 后端 detail（类型/大小/命名不合规的具体原因）
 * → 我方 hook 的可执行文案 → 兜底提示。
 * **绝不**把 `Request failed with status code 400` 这种甩给用户。
 */
export function uploadErrorMessage(err: unknown): string {
  const parts = apiErrorParts(err);
  if (isServiceUnavailable(parts)) return SERVICE_UNAVAILABLE_MESSAGE;
  return parts.detail ?? "上传失败（类型/大小/命名不合规时后端会明确拒绝）";
}

/**
 * 排序失败提示。
 *
 * `sort_order` 是人工维护的展示位次，后端限定 0–9999；越界是**用户可修正**的输入错误，
 * 必须把后端那句话（"排序值需在 0 ~ 9999 之间"）带出来。其它错误给可重试的通用提示。
 */
export function sortErrorMessage(err: unknown): string {
  const parts = apiErrorParts(err);
  if (isServiceUnavailable(parts)) {
    return "服务暂时不可用（后台内核正在启动），已自动重试；请稍后重试排序";
  }
  if (parts.status === 422 && parts.detail) return `排序失败：${parts.detail}`;
  return "排序失败，请重试";
}

/**
 * 非上传类写操作（改名 / 设主图 / 移除 / 复制链接）的失败提示。
 *
 * 后端有可执行原因就透出来；服务不可用时给统一的可恢复文案（透出
 * `kernel unreachable` 这类内部英文只会让用户以为是自己弄坏了什么）。
 */
export function actionErrorMessage(err: unknown, fallback: string): string {
  const parts = apiErrorParts(err);
  if (isServiceUnavailable(parts)) return SERVICE_UNAVAILABLE_MESSAGE;
  return parts.detail ? `${fallback}：${parts.detail}` : fallback;
}
