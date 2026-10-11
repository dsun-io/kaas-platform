/**
 * API 错误体归一化 —— 后端有**两种**错误外形，前端必须都认。
 *
 * 为什么需要这个文件（而不是各页面自己 `err.response.data.message`）：
 *   · 中间件直接吐 JSONResponse，体是**扁平**的（工位未开通就是这一类）：
 *     `{"error":"not_found","code":"WORKSTATION_NOT_SUBSCRIBED","workstation":"customers","detail":"…"}`
 *   · 路由里的 `HTTPException(detail={...})` 会被框架包一层，体是**嵌套**的（团队接口全部如此）：
 *     `{"detail":{"error":"conflict","code":"ALREADY_IN_TEAM","message":"你已属于一个团队"}}`
 *   · 只写一种解析，另一种就表现为"后端明明给了 message，前端却弹通用『请求失败』"。
 *     团队/工位的错误码是**给人看的提示**的唯一来源，解析只留一份，才不会各处漂移。
 *
 * 本模块是纯函数（不依赖 axios / React），便于单测；调用方传原始 `error` 即可。
 */

/** 解析后的统一错误形态 */
export interface NormalizedApiError {
  /** HTTP 状态码；网络层失败（无响应）为 null */
  status: number | null;
  /** 业务错误码：`code`（新契约）或 `error_code`（旧契约，仍兼容） */
  code: string | null;
  /** 给人看的文案：后端 message/detail 优先，其次调用方给的业务码文案，最后兜底 */
  message: string;
  /** 后端 detail 字符串（422 的字段级说明常放这里） */
  detail: string | null;
  /** 工位未开通时后端会带上是哪个工位 */
  workstation: string | null;
  /** true = 压根没连上（无 response），不是后端返回的业务错误 */
  isNetworkError: boolean;
}

const FALLBACK_MESSAGE = "请求失败，请稍后重试";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item !== "");
}

/** 归一化**响应体**（不含 axios 外壳），便于单测直接喂 JSON。 */
export function normalizeApiErrorPayload(
  payload: unknown,
  status: number | null = null,
): NormalizedApiError {
  const body = asRecord(payload);
  // 嵌套优先：`{"detail":{...}}` 里的才是业务错误体；`{"detail":"字符串"}` 则是纯文案
  const nested = asRecord(body?.["detail"]);
  const source = nested ?? body;

  const code =
    asText(source?.["code"]) ??
    asText(source?.["error_code"]) ??
    asText(body?.["code"]) ??
    asText(body?.["error_code"]);

  const detail =
    asText(source?.["detail"]) ??
    (typeof body?.["detail"] === "string" ? asText(body["detail"]) : null);

  const message =
    asText(source?.["message"]) ?? detail ?? asText(body?.["message"]);

  const workstation =
    asText(body?.["workstation"]) ?? asText(source?.["workstation"]);

  return {
    status,
    code,
    message: message ?? "",
    detail,
    workstation,
    isNetworkError: false,
  };
}

/**
 * 归一化一个**捕获到的异常**（axios 错误 / 任意抛出物）。
 *
 * `message` 优先用响应体里的后端文案；没有后端文案时退化成 `error.message`
 * （例如网络错误的 "Network Error"），保持既有调用方看到的行为不变。
 */
export function normalizeApiError(error: unknown): NormalizedApiError {
  const outer = asRecord(error);
  const response = asRecord(outer?.["response"]);
  const status =
    typeof response?.["status"] === "number" ? response["status"] : null;

  const parsed = normalizeApiErrorPayload(response?.["data"], status);
  const ownMessage = asText(outer?.["message"]);

  return {
    ...parsed,
    message: parsed.message || ownMessage || FALLBACK_MESSAGE,
    isNetworkError: response === null,
  };
}

/** 取错误码（兼容扁平 / 嵌套两种外形）。 */
export function apiErrorCode(error: unknown): string | null {
  return normalizeApiError(error).code;
}

/** 网络/降级文案：接口还没上线时各页面统一这么说。 */
export const API_UNAVAILABLE_MESSAGE = FALLBACK_MESSAGE;

export { asStringArray as toStringArray };
