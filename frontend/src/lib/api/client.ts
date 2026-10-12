import axios from "axios";
import type { AxiosError } from "axios";
import { getCurrentSession } from "@/lib/auth/session-cache";
import { resolveUseV2 } from "./use-v2-resolver";
import { API_BASE_URL } from "./config";
import { handleApiError } from "./error-handler";
import type { ApiErrorResponse } from "./error-handler";

/**
 * 给 axios 的请求配置加一个前端专用开关（只影响错误处理，不会作为请求头发出去）。
 *
 * `silent: true` = "这个请求失败了由调用方自己降级"：团队 / 工位这些**可能还没上线**的接口，
 * 失败时不应弹通用 toast（用户会以为系统坏了），而应由页面渲染骨架 / 空态 / 引导。
 */
declare module "axios" {
  export interface AxiosRequestConfig {
    silent?: boolean;
  }
}

const BASE_URL = `${API_BASE_URL}/api/v1`;

export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

// ── Request interceptor ──────────────────────────────────────────────
apiClient.interceptors.request.use((config) => {
  const session = getCurrentSession();

  // Public auth paths — never inject auth headers
  const path = config.url || "";
  const isAuthPath =
    /^\/auth\/(login|register|logout|bootstrap-admin|forgot-password|reset-password)/.test(
      path,
    );

  if (!isAuthPath) {
    // **不再注入 X-Tenant-Id。**
    //
    // 原因：`tenant_id` 已全量统一为 `default`（迁移 202610110005 `unify_tenant`），
    // **租户不再是隔离边界，团队（team_id）才是**；而账号身上根本没有"租户"
    // （见 docs/TEAMS_AND_VISIBILITY.md）。
    //
    // 而原先这个头是从 **localStorage 里过期的 `kaas_user`** 反推的
    // （`updateSession` 从来不写它）—— 也就是说发出去的可能是**早已失效的旧值**，
    // 后端还会拿它做限流分桶与日志上下文，属于"看着有用、实际误导"。
    //
    // 后端不需要它：`middleware/auth.py` 在鉴权后自行把
    // `request.state.tenant_id` 设为 DEFAULT_TENANT。
    // 限流 key 是 `{tenant_id}:{ip}`，**仍含 IP**，且本部署租户恒为 default，
    // 所以去掉这个头不改变限流效果。
    // Authorization (Phase 0: skip if no token)
    if (session.accessToken) {
      config.headers.set("Authorization", `Bearer ${session.accessToken}`);
    }
  }

  // X-Use-V2
  config.headers.set("X-Use-V2", resolveUseV2() ? "true" : "false");

  return config;
});

// ── 幂等请求的 5xx 重试 ───────────────────────────────────────────────
// Cloudflare Workers（Python/Pyodide）冷启动偶发抛异常，表现为 5xx/网络错误；
// 新版本切换后的一段时间内更明显。GET/HEAD 幂等，可安全重试。
// 写请求（POST/PATCH/DELETE）不自动重试，避免重复副作用。
const RETRY_METHODS = new Set(["get", "head", "options"]);
// 登录是幂等的（重放不会产生副作用），而冷启动窗口内用户最可能就卡在这一步，
// 故对 POST /auth/login 单独放行重试。其余写请求一律不重试，避免重复副作用。
const RETRY_POST_PATHS = [/\/auth\/login$/];
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 400;

function isRetryableRequest(method: string, url: string | undefined): boolean {
  if (RETRY_METHODS.has(method)) return true;
  return (
    method === "post" && !!url && RETRY_POST_PATHS.some((re) => re.test(url))
  );
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorResponse>) => {
    const config = error.config as
      | (typeof error.config & { __retryCount?: number })
      | undefined;
    const status = error.response?.status;
    const method = (config?.method ?? "").toLowerCase();
    const retriable = status === undefined || (status >= 500 && status < 600);

    if (config && retriable && isRetryableRequest(method, config.url)) {
      const attempt = config.__retryCount ?? 0;
      if (attempt < MAX_RETRIES) {
        config.__retryCount = attempt + 1;
        await new Promise((r) =>
          setTimeout(r, RETRY_BASE_DELAY_MS * 3 ** attempt),
        );
        return apiClient.request(config);
      }
    }

    handleApiError(error);
    return Promise.reject(error);
  },
);

export default apiClient;
