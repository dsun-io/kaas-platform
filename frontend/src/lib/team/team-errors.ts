/**
 * 团队 / 工位接口的错误码 → 中文文案（对照 docs/FRONTEND_PRODUCTION_READINESS.md §B2）。
 *
 * 为什么要"文案表 + 后端 message"两层（而不是只用其中一个）：
 *   · 后端 `message`/`detail` 是**这句话真实发生了什么**（如「已存在同名团队「联佳」」），
 *     信息量最大，必须优先展示 —— 吞掉它，用户就只知道"操作失败"；
 *   · 但不少分支只有 `code`（如 410 INVITE_EXPIRED、404 MEMBER_NOT_FOUND 不带 message），
 *     这些必须由前端翻译成人话；
 *   · 后端偶尔给英文技术文案（例如 `conflict: Email already registered`），
 *     这时有中文码表就用码表，别把英文怼给用户。
 */
import { normalizeApiError } from "@/lib/api/api-error";

export const TEAM_ERROR_TEXT: Record<string, string> = {
  ALREADY_IN_TEAM: "你已属于一个团队",
  TEAM_NAME_TAKEN: "已有同名团队",
  NOT_TEAM_ADMIN: "只有团队管理员可以操作",
  CANNOT_REMOVE_SELF: "不能移除团队管理员本人",
  INVITE_NOT_FOUND: "邀请无效（不存在或已被删除）",
  INVITE_REVOKED: "邀请已撤销",
  INVITE_EXPIRED: "邀请已过期",
  INVITE_ALREADY_USED: "邀请已被使用",
  INVALID_TEAM_NAME: "团队名称不合法（2-30 个字符）",
  INVALID_INVITE_TOKEN: "请填写邀请码或邀请链接",
  INVITE_TOKEN_GENERATION_FAILED: "邀请码生成失败，请重试",
  MEMBER_NOT_FOUND: "该成员不在本团队",
  TEAM_NOT_FOUND: "团队不存在，或你无权访问",
  WORKSTATION_NOT_SUBSCRIBED: "该工位未开通",
  UNKNOWN_WORKSTATION: "未知工位",
  SUBSCRIPTION_NOT_FOUND: "该工位尚未开通过",
  INVALID_EXPIRES_AT: "到期时间格式不正确",
  TEAM_ACTION_CONFLICT: "只能二选一：加入现有团队，或新建团队",
  ADMIN_ONLY: "仅平台管理员可操作",
  USER_NOT_FOUND: "登录状态异常，请重新登录",
};

/** 是否包含中文字符（用来判断后端文案能不能直接给用户看） */
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text);
}

/**
 * 团队/工位类错误 → 给人看的中文文案。
 * 优先级：后端 message/detail（中文时）> 码表中文 > 有业务码时的后端原文 > 兜底。
 *
 * 没有业务码又没有中文（例如网络错误的 "Network Error"）时**不给用户看英文**，
 * 直接用兜底人话 —— 用户看到 "Network Error" 除了困惑没有别的用处。
 */
export function teamErrorMessage(
  error: unknown,
  fallback = "操作失败，请稍后重试",
): string {
  const { code, message } = normalizeApiError(error);
  const mapped = code ? TEAM_ERROR_TEXT[code] : undefined;

  if (message && hasChinese(message)) return message;
  if (mapped) return mapped;
  if (code && message) return message;
  return fallback;
}
