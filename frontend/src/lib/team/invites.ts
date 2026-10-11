/**
 * 邀请链接（纯函数）—— 团队邀请的两个分支都要用。
 *
 * 为什么前端要自己拼链接：邀请接口只回 `token`（24 位、去掉了易混字符），
 * 但用户实际要发给同事的是**一条能点的链接**；后端注册接口会自己从链接里取 `?token=`，
 * 所以这里拼 `/register?token=<code>` 即可，两端不需要再约定新字段。
 *
 * 为什么 `origin` 可传：单测里没有 `window`，必须能注入一个确定的前缀。
 */
export function buildInviteLink(token: string, origin?: string): string {
  const code = token.trim();
  const runtimeOrigin =
    origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  const base = runtimeOrigin.replace(/\/+$/, "");
  return `${base}/register?token=${encodeURIComponent(code)}`;
}

/** 邀请状态 → 中文（列表里显示；后端 status ∈ pending/accepted/revoked） */
export const INVITE_STATUS_TEXT: Record<string, string> = {
  pending: "待接受",
  accepted: "已接受",
  revoked: "已撤销",
};

/**
 * 邀请行现在处于什么状态。
 *
 * 后端把"过期"算成**状态判定**（`invite_state()`），列表里的 `status` 仍是 `pending`
 * —— 所以前端要自己把 `expires_at` 与当前时间比一下，否则管理员会看到一堆
 * "待接受"的过期码，还会拿去发人。
 */
export function inviteStateLabel(
  status: string | null | undefined,
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): string {
  if (status === "accepted") return INVITE_STATUS_TEXT["accepted"] ?? "已接受";
  if (status === "revoked") return INVITE_STATUS_TEXT["revoked"] ?? "已撤销";
  if (expiresAt) {
    const ts = Date.parse(expiresAt);
    if (!Number.isNaN(ts) && ts <= now) return "已过期";
  }
  return INVITE_STATUS_TEXT[status ?? "pending"] ?? status ?? "待接受";
}

/** 是否还能用（可复制 / 可撤销）—— 已接受与已撤销的码没有操作价值 */
export function isInviteActionable(
  status: string | null | undefined,
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (status === "accepted" || status === "revoked") return false;
  if (expiresAt) {
    const ts = Date.parse(expiresAt);
    if (!Number.isNaN(ts) && ts <= now) return false;
  }
  return true;
}

/** 提交给后端的邀请码：允许用户粘贴**整条邀请链接**，这里先试着把 token 抠出来 */
export function extractInviteToken(raw: string): string {
  const text = raw.trim();
  if (text === "") return "";
  // 整条链接（http/https 或站内相对链接）里的 ?token= 才是邀请码
  const match = /[?&]token=([^&\s]+)/.exec(text);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]).trim();
    } catch {
      return match[1].trim();
    }
  }
  return text;
}
