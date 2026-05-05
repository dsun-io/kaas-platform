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
  tenant: { tenant_id: "lianjia" },
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
      role: partial.user.account_type,
    };
  } else if (partial.user === null) {
    _session.user = undefined;
  }
}

export function resetSession(): void {
  _session = {
    tenant: { tenant_id: "lianjia" },
    accessToken: null,
    user: undefined,
  };
}
