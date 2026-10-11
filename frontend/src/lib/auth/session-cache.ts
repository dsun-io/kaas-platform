/**
 * Module-level session cache — read by axios interceptors for auth headers.
 * Updated by AuthProvider after login/logout/me.
 */
import type { UserInfo } from "./types";
import { getToken } from "./token-store";

export interface Session {
  accessToken: string | null;
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

let _session: Session = {
  accessToken: null,
};

export function getCurrentSession(): Session {
  // On first access in a new page load, try to hydrate from localStorage
  if (!_session.accessToken) {
    const token = getToken();
    if (token) {
      _session.accessToken = token;
    }
  }
  return _session;
}

export function updateSession(partial: {
  accessToken?: string | null;
  user?: UserInfo | null;
}): void {
  if (partial.accessToken !== undefined) {
    _session.accessToken = partial.accessToken;
  }
  if (partial.user !== undefined && partial.user !== null) {
    _session.user = {
      id: String(partial.user.user_id),
      email: partial.user.email,
      role: partial.user.role ?? partial.user.account_type,
    };
    // 账号**不再有"租户"**（业务不以租户鉴权，见 docs/TEAMS_AND_VISIBILITY.md）：
    // `tenant_id` 已全量统一为 `default`，隔离边界是**团队**（team_id）。
    // 所以这里连"租户"这个字段都不再保留 —— 原先那个 `tenant.{tenant_id}`
    // 只会从 **localStorage 里过期的 `kaas_user`** 反推（本函数从不写它），
    // 发出去的可能是早已失效的旧值，属于"看着有用、实际误导"。
    // 后端不需要它：`middleware/auth.py` 鉴权后自行设 DEFAULT_TENANT。
  } else if (partial.user === null) {
    _session.user = undefined;
  }
}

export function resetSession(): void {
  _session = {
    accessToken: null,
    user: undefined,
  };
}
