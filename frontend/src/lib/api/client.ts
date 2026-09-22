import axios from "axios";
import type { AxiosError } from "axios";
import { getCurrentSession } from "@/lib/auth/session-cache";
import { resolveUseV2 } from "./use-v2-resolver";
import { API_BASE_URL } from "./config";
import { handleApiError } from "./error-handler";
import type { ApiErrorResponse } from "./error-handler";

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

  // Public auth paths — never inject tenant or auth headers
  const path = config.url || "";
  const isAuthPath =
    /^\/auth\/(login|register|logout|bootstrap-admin|forgot-password)/.test(
      path,
    );

  if (!isAuthPath) {
    // X-Tenant-Id: only inject if a real tenant_id is available
    const tenantId = session.tenant.tenant_id;
    if (tenantId) {
      config.headers.set("X-Tenant-Id", tenantId);
    }

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
    method === "post" &&
    !!url &&
    RETRY_POST_PATHS.some((re) => re.test(url))
  );
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorResponse>) => {
    const config = error.config as (typeof error.config & { __retryCount?: number }) | undefined;
    const status = error.response?.status;
    const method = (config?.method ?? "").toLowerCase();
    const retriable =
      status === undefined || (status >= 500 && status < 600);

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
