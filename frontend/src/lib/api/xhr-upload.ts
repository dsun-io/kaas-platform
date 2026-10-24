/**
 * XHR 上传传输层 —— 只为「要进度条」的上传路径服务。
 *
 * 为什么不用 axios / fetch：
 *  · `fetch` 没有上传进度（`ReadableStream` 请求体在浏览器里不可观测）；
 *  · axios 的 `onUploadProgress` 底层也是 XHR，直接用 XHR 少一层抽象、错误体更好控。
 *
 * 为什么在这里复刻鉴权头，而不是复用 apiClient 的拦截器：
 * XHR 不经过 axios 实例。`client.ts` 的拦截器做两件事（注入 Bearer、X-Use-V2），
 * 这里按**同一口径**重放一遍；`API_BASE_URL` 也从同一处取，避免两套 base 漂移。
 *
 * 错误形状：`XhrHttpError` 故意长成 axios 错误的样子（`error.response.{status,data}`），
 * 这样 `upload-errors.ts` 里那套「后端 detail 优先、通用文案过滤」的口径不用改一行。
 */
import { API_BASE_URL } from "./config";
import { getCurrentSession } from "@/lib/auth/session-cache";
import { resolveUseV2 } from "./use-v2-resolver";

const BASE_URL = `${API_BASE_URL}/api/v1`;

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0–100 的整数；服务端没给 total 时为 null（进度条改用不确定态） */
  percent: number | null;
}

export type UploadProgressHandler = (progress: UploadProgress) => void;

export interface XhrResult {
  ok: boolean;
  status: number;
  /** 响应体原文（JSON 或空串） */
  text: string;
}

/** 与 axios 错误同形：调用方（upload-errors.ts）照旧能拆出 status/code/detail */
export class XhrHttpError extends Error {
  response: { status: number; data: unknown };

  constructor(status: number, data: unknown, message: string) {
    super(message);
    this.name = "XhrHttpError";
    this.response = { status, data };
  }
}

function parseJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** 与 `client.ts` 请求拦截器同口径（Bearer + X-Use-V2；不带 X-Tenant-Id） */
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Use-V2": resolveUseV2() ? "true" : "false",
  };
  const session = getCurrentSession();
  if (session.accessToken) {
    headers.Authorization = `Bearer ${session.accessToken}`;
  }
  return headers;
}

interface SendOptions {
  method: "POST" | "PUT";
  /** 站内相对路径（自动补 `${API_BASE_URL}/api/v1`），与 `url` 二选一 */
  path?: string;
  /** 绝对地址（对象存储预签名 URL），**不要**带我们的鉴权头 */
  url?: string;
  body: XMLHttpRequestBodyInit;
  headers?: Record<string, string>;
  onProgress?: UploadProgressHandler;
  /** 超时毫秒；默认 60s（8MB 图在弱网下也够） */
  timeoutMs?: number;
}

/**
 * 发一次上传请求。**网络层失败（断网/CORS）会 reject**，HTTP 非 2xx 不 reject
 * （由调用方决定是回退还是报错——直传被拒要回退，代理被拒要报错）。
 */
export function xhrSend({
  method,
  path,
  url,
  body,
  headers,
  onProgress,
  timeoutMs = 60_000,
}: SendOptions): Promise<XhrResult> {
  return new Promise<XhrResult>((resolve, reject) => {
    const target = url ?? `${BASE_URL}${path ?? ""}`;
    const xhr = new XMLHttpRequest();
    xhr.open(method, target, true);
    xhr.timeout = timeoutMs;

    const baseHeaders = url ? { ...headers } : { ...authHeaders(), ...headers };
    // FormData 的 Content-Type **只能由浏览器补**（它要生成 boundary）：
    // 作者设过的值 XHR 会原样发出去，服务端收到的就是没有 boundary 的
    // `multipart/form-data` ⇒ FastAPI/Starlette 直接 400「Missing boundary in multipart.」
    // （2026-10-24 线上产品图上传事故的根因）。口径与 axios 浏览器适配器一致：
    // isFormData ⇒ headers.setContentType(undefined)（"Let the browser set it"）。
    const isFormData =
      typeof FormData !== "undefined" && body instanceof FormData;
    const allHeaders = isFormData
      ? Object.fromEntries(
          Object.entries(baseHeaders).filter(
            ([key]) => key.toLowerCase() !== "content-type",
          ),
        )
      : baseHeaders;
    for (const [key, value] of Object.entries(allHeaders)) {
      xhr.setRequestHeader(key, value);
    }

    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        const total = event.lengthComputable ? event.total : 0;
        onProgress({
          loaded: event.loaded,
          total,
          percent:
            total > 0
              ? Math.min(100, Math.round((event.loaded / total) * 100))
              : null,
        });
      };
    }

    xhr.onload = () => {
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: xhr.responseText,
      });
    };
    xhr.onerror = () => reject(new TypeError("Network Error"));
    xhr.ontimeout = () =>
      reject(new TypeError(`上传超时（${Math.round(timeoutMs / 1000)}s）`));
    xhr.onabort = () => reject(new TypeError("上传已取消"));

    xhr.send(body);
  });
}

/**
 * 站内 multipart 上传（服务端代传兜底）：非 2xx 抛 `XhrHttpError`，
 * 2xx 返回解析后的 JSON。
 *
 * **这里不设 `Content-Type`**（历史 bug，2026-10-24 线上事故）：
 * 一旦设成 `multipart/form-data`，浏览器就不再补 `; boundary=…`，
 * 请求头与请求体不匹配 ⇒ 内核 400「Missing boundary in multipart.」。
 * boundary 只能由发送方（浏览器）生成，调用方也不该传这个头。
 */
export async function xhrPostForm(
  path: string,
  form: FormData,
  onProgress?: UploadProgressHandler,
): Promise<unknown> {
  const result = await xhrSend({
    method: "POST",
    path,
    body: form,
    onProgress,
  });
  const data = parseJson(result.text);
  if (!result.ok) {
    throw new XhrHttpError(
      result.status,
      data,
      `上传失败（HTTP ${result.status}）`,
    );
  }
  return data;
}
