import { AxiosError } from "axios";
import { toast } from "sonner";
import { captureException, addBreadcrumb } from "@/lib/error/sentry";

export interface ApiErrorResponse {
  error_code: string;
  message: string;
  detail?: Record<string, unknown>;
}

const ERROR_CODE_MAP: Record<string, string> = {
  PARAM_EXTRACTION_FAILED: "参数识别失败，请用更详细的规格描述重试",
  SPEC_NOT_SUPPORTED: "该规格暂不支持报价，请联系客服",
  KB_SEARCH_FAILED: "知识库查询超时，请稍后重试",
  LLM_UNAVAILABLE: "AI 服务暂时不可用，已使用模板生成",
  QUOTATION_NOT_FOUND: "报价记录不存在",
  TENANT_NOT_FOUND: "租户配置未找到，请检查设置",
  VALIDATION_ERROR: "请求参数不合法",
  UNAUTHORIZED: "登录已过期，请重新登录",
  FORBIDDEN: "无权限执行此操作",
  RATE_LIMITED: "请求过于频繁，请稍后重试",
  INTERNAL_ERROR: "服务器内部错误，请稍后重试",
};

function captureApiError(
  error: AxiosError<ApiErrorResponse>,
  extra?: Record<string, unknown>,
) {
  addBreadcrumb({
    category: "api",
    message: `[${error.response?.status ?? "NETWORK"}] ${error.response?.data?.error_code ?? error.message}`,
    level: "error",
    data: { url: error.config?.url, ...extra },
  });
  captureException(error, { context: "api-error", ...extra });
}

function isLoginPage(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.pathname === "/login";
}

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (isLoginPage()) return; // Already on login, no redirect needed

  const currentPath = window.location.pathname + window.location.search;
  const redirect = encodeURIComponent(currentPath);
  window.location.href = "/login?redirect=" + redirect;
}

export function handleApiError(error: AxiosError<ApiErrorResponse>): string {
  const data = error.response?.data;
  const status = error.response?.status;

  if (data?.error_code) {
    const msg = ERROR_CODE_MAP[data.error_code] || data.message || "未知错误";
    toast.error(msg);
    captureApiError(error, { errorCode: data.error_code });
    return msg;
  }

  if (status === 401) {
    // Login endpoint failures: let the login form handle the error
    const isAuthLogin = error.config?.url === "/auth/login";
    if (!isAuthLogin) {
      toast.error("登录已过期");
    }
    redirectToLogin();
    return data?.message || "Unauthorized";
  }

  if (status === 403) {
    toast.error("无权限");
  } else if (status === 429) {
    toast.error("请求过于频繁");
  } else if (status && status >= 500) {
    toast.error("后端忙碌，请稍后重试");
    captureApiError(error);
  } else if (status && status >= 400) {
    toast.error(data?.message || "请求失败");
  } else {
    toast.error(data?.message || "请求失败");
  }

  return data?.message || error.message;
}
