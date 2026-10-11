/**
 * Module-level session cache — read by axios interceptors for auth headers.
 * Updated by AuthProvider after login/logout/me.
 */
import type { UserInfo } from "./types";
import { getToken } from "./token-store";

export interface Session {
  tenant: {
    tenant_id: string;
  };
  accessToken: string | null;
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

let _session: Session = {
  tenant: { tenant_id: "" },
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
  // Hydrate tenant from stored user if not yet set
  if (!_session.tenant.tenant_id) {
    try {
      const stored =
        localStorage.getItem("kaas_user") ||
        sessionStorage.getItem("kaas_user");
      if (stored) {
        const user = JSON.parse(stored);
        if (user?.tenant_id) {
          _session.tenant.tenant_id = user.tenant_id;
        }
      }
    } catch {
      // ignore parse errors
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
    // 账号不再有"租户"（业务不以租户鉴权，见 docs/TEAMS_AND_VISIBILITY.md）：
    // 这里不再从 auth 响应写 X-Tenant-Id —— 后端要么忽略它（Worker 固定 DEFAULT_TENANT），
    // 要么从登录态自行推导。保留默认空值，避免把"团队 id"塞进租户头造成误解。
  } else if (partial.user === null) {
    _session.user = undefined;
  }
}

export function resetSession(): void {
  _session = {
    tenant: { tenant_id: "" },
    accessToken: null,
    user: undefined,
  };
}
