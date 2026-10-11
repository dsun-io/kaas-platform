import { AxiosError } from "axios";
import { toast } from "sonner";
import { captureException, addBreadcrumb } from "@/lib/error/sentry";
import { clearAuthSession } from "@/lib/auth/token-store";
import {
  notifyWorkstationLocked,
  WORKSTATION_NOT_SUBSCRIBED,
} from "@/lib/workstation/lock-events";
import { normalizeApiError } from "./api-error";

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

  // Clear stored session so the Next.js middleware won't bounce us back
  clearAuthSession();

  const currentPath = window.location.pathname + window.location.search;
  const redirect = encodeURIComponent(currentPath);
  window.location.href = "/login?redirect=" + redirect;
}

export function handleApiError(error: AxiosError<ApiErrorResponse>): string {
  // 统一解析（扁平 / 嵌套两种错误体都认），后续分支只读解析结果
  const normalized = normalizeApiError(error);
  const status = normalized.status;
  const config = error.config;

  // ── ① 工位未开通：这是**可预期的业务状态**，不是错误 ────────────────
  // 后端对未开通工位一律回 404（不暴露工位存在性），前端必须把它翻译成
  // 「该工位未开通」引导页，而不是通用报错 —— 否则用户以为系统坏了。
  // 这里只负责"广播"，渲染由 WorkstationGate 完成（避免在工具函数里碰 React）。
  if (normalized.code === WORKSTATION_NOT_SUBSCRIBED) {
    notifyWorkstationLocked(normalized.workstation);
    captureApiError(error, {
      errorCode: normalized.code,
      workstation: normalized.workstation,
    });
    return normalized.message;
  }

  // ── ② 401：登录态失效必须统一处理（清 session + 跳登录），不能停在白屏 ──
  if (status === 401) {
    // Login endpoint failures: let the login form handle the error
    const isAuthLogin = config?.url === "/auth/login";
    if (!isAuthLogin) {
      toast.error("登录已过期");
    }
    redirectToLogin();
    return normalized.message;
  }

  // ── ③ 调用方声明自己降级（silent）：接口可能还没上线，只留痕不打扰用户 ──
  if (config?.silent) {
    addBreadcrumb({
      category: "api",
      message:
        `[${status ?? "NETWORK"}] silent ${normalized.code ?? ""}`.trim(),
      level: "warning",
      data: { url: config.url },
    });
    return normalized.message;
  }

  // ── ④ 已知业务码：用固定中文文案（口径统一，不随后端措辞漂移）──
  const mapped = normalized.code ? ERROR_CODE_MAP[normalized.code] : undefined;
  if (mapped) {
    toast.error(mapped);
    captureApiError(error, { errorCode: normalized.code });
    return mapped;
  }

  // ── ⑤ 未知业务码：显示后端自己的 message/detail，绝不吞掉 ──
  if (normalized.code) {
    toast.error(normalized.message);
    captureApiError(error, { errorCode: normalized.code });
    return normalized.message;
  }

  if (status === 403) {
    toast.error("无权限");
  } else if (status === 429) {
    toast.error("请求过于频繁");
  } else if (status && status >= 500) {
    toast.error("后端忙碌，请稍后重试");
    captureApiError(error);
  } else if (status && status >= 400) {
    toast.error(normalized.message);
  } else {
    toast.error(normalized.message);
  }

  return normalized.message;
}
