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
const GENERIC_NETWORK = new Set(["Network Error", "Failed to fetch", "Load failed"]);

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
  const code = nonEmpty(data?.["code"]) ?? nonEmpty(data?.["error_code"]);

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
 * 上传失败提示。
 *
 * 优先级：后端 detail（类型/大小/命名不合规的具体原因）→ 我方 hook 的可执行文案
 * → 兜底提示。**绝不**把 `Request failed with status code 400` 这种甩给用户。
 */
export function uploadErrorMessage(err: unknown): string {
  return (
    apiErrorParts(err).detail ??
    "上传失败（类型/大小/命名不合规时后端会明确拒绝）"
  );
}

/**
 * 排序失败提示。
 *
 * `sort_order` 是人工维护的展示位次，后端限定 0–9999；越界是**用户可修正**的输入错误，
 * 必须把后端那句话（"排序值需在 0 ~ 9999 之间"）带出来。其它错误给可重试的通用提示。
 */
export function sortErrorMessage(err: unknown): string {
  const { status, detail } = apiErrorParts(err);
  if (status === 422 && detail) return `排序失败：${detail}`;
  return "排序失败，请重试";
}
