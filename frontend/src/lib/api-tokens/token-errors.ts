/**
 * API 令牌错误文案归一化。
 *
 * 后端错误信封是 FastAPI 形状 `{"detail":{error,code,message}}` / `{"detail":[pydantic issues]}`
 * —— 统一走 `normalizeApiError`，这里只补本域的错误码映射，避免创建/吊销两处各写一套。
 */
import { normalizeApiError } from "@/lib/api/api-error";

export function formatApiTokenError(error: unknown): string {
  const info = normalizeApiError(error);

  switch (info.code) {
    case "TOKEN_ALREADY_REVOKED":
      return "该系统对接密钥已经撤销，请刷新列表后重试。";
    case "TOKEN_NOT_FOUND":
      return "密钥不存在，或不属于当前账号。";
    case "UNKNOWN_SCOPE":
      // 后端 message 会列出白名单；原样透出比通用文案更有用。
      return info.message || "选择了系统不支持的权限范围，请刷新页面后重试。";
    default:
      break;
  }

  if (info.status === 401) return "登录已失效，请重新登录后再试。";
  if (info.status === 403) return "无权限执行此操作。";
  return info.message || "请求失败，请稍后重试。";
}
