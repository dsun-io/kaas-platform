import axios from "axios";
import type { AxiosError } from "axios";
import { getCurrentSession } from "@/lib/auth/session-cache";
import { resolveUseV2 } from "./use-v2-resolver";
import { isMockMode, API_BASE_URL } from "./config";
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

// ── Response interceptor ─────────────────────────────────────────────
apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiErrorResponse>) => {
    handleApiError(error);
    return Promise.reject(error);
  },
);

export default apiClient;
