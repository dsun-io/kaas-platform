"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import apiClient from "@/lib/api/client";
import { updateSession, resetSession } from "./session-cache";
import {
  getToken,
  setAuthSession,
  clearAuthSession,
  getUser,
} from "./token-store";
import type { UserInfo, AuthState, RegisterRequest } from "./types";

interface AuthContextValue extends AuthState {
  login: (
    email: string,
    password: string,
    rememberMe?: boolean,
  ) => Promise<void>;
  register: (data: RegisterRequest) => Promise<void>;
  setupAdmin: (data: {
    email: string;
    password: string;
    display_name: string;
    setup_token: string;
  }) => Promise<void>;
  /** 修改本人显示名（后端 PATCH /auth/me；只改自己，邮箱不可自助改） */
  updateProfile: (displayName: string) => Promise<void>;
  /** 修改本人密码（后端 POST /auth/change-password，必须验旧密码） */
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SAFE_REDIRECT_PATTERN = /^\/[^/\\]/;

function safeRedirect(raw: string | null): string {
  if (
    raw &&
    raw !== "/login" &&
    SAFE_REDIRECT_PATTERN.test(raw) &&
    !raw.startsWith("//")
  ) {
    return raw;
  }
  // 默认落到 "/"（角色感知路由页）：internal → /customers，customer → /products
  return "/";
}

// Build UserInfo from a login/register/me response payload
function buildUser(data: Record<string, unknown>): UserInfo {
  return {
    user_id: data.user_id as number,
    email: (data.email as string) ?? "",
    display_name: (data.display_name as string) ?? "",
    account_type: (data.account_type as "internal" | "customer") ?? "customer",
    role: (data.role as string) ?? "user",
    plan: (data.plan as string) ?? "free",
    team_id: (data.team_id as number) ?? null,
    team_name: (data.team_name as string) ?? null,
    console_access: (data.console_access as boolean) ?? false,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    isLoading: true,
    isAuthenticated: false,
  });

  // On mount: try to restore session from storage
  useEffect(() => {
    const restore = async () => {
      const token = getToken();
      if (!token) {
        setState((s) => ({ ...s, isLoading: false }));
        return;
      }

      try {
        const res = await apiClient.get("/auth/me");
        const user = buildUser(res.data);
        // Re-store to keep storage in sync after /me response
        const userFromStore = getUser();
        const rememberMe = !!localStorage.getItem("kaas_token");
        setAuthSession({ token, user, rememberMe });
        updateSession({ accessToken: token, user });
        setState({ user, token, isLoading: false, isAuthenticated: true });
      } catch {
        clearAuthSession();
        resetSession();
        setState({
          user: null,
          token: null,
          isLoading: false,
          isAuthenticated: false,
        });
      }
    };
    restore();
  }, []);

  const login = useCallback(
    async (email: string, password: string, rememberMe = false) => {
      const res = await apiClient.post("/auth/login", { email, password });
      const user = buildUser(res.data);
      const token: string = res.data.access_token;

      setAuthSession({ token, user, rememberMe });
      updateSession({ accessToken: token, user });

      setState({ user, token, isLoading: false, isAuthenticated: true });

      const redirect = safeRedirect(searchParams.get("redirect"));
      window.location.href = redirect;
    },
    [searchParams],
  );

  const register = useCallback(async (data: RegisterRequest) => {
    const res = await apiClient.post("/auth/register", data);
    const user = buildUser(res.data);
    const token: string = res.data.access_token;

    // Registration: always use sessionStorage (user just signed up, not "remember me" yet)
    setAuthSession({ token, user, rememberMe: false });
    updateSession({ accessToken: token, user });

    setState({ user, token, isLoading: false, isAuthenticated: true });

    window.location.href = "/onboarding";
  }, []);

  const setupAdmin = useCallback(
    async (data: {
      email: string;
      password: string;
      display_name: string;
      setup_token: string;
    }) => {
      const res = await apiClient.post(
        "/auth/bootstrap-admin",
        {
          email: data.email,
          password: data.password,
          display_name: data.display_name,
        },
        {
          headers: { Authorization: `Bearer ${data.setup_token}` },
        },
      );
      const user = buildUser(res.data);
      const token: string = res.data.access_token;

      setAuthSession({ token, user, rememberMe: false });
      updateSession({ accessToken: token, user });

      setState({ user, token, isLoading: false, isAuthenticated: true });

      window.location.href = "/dashboard";
    },
    [],
  );

  /**
   * 修改本人资料（目前只有显示名）。
   * 为什么改完要回写会话缓存：侧栏/顶栏直接读 `user.display_name`，只改服务端不回写
   * 会出现"保存成功但界面还是旧名字"，刷新才变 —— 用户会以为没保存上。
   */
  const updateProfile = useCallback(
    async (displayName: string) => {
      const res = await apiClient.patch("/auth/me", {
        display_name: displayName,
      });
      const user = buildUser(res.data);
      const token = state.token ?? getToken() ?? "";
      const rememberMe = !!localStorage.getItem("kaas_token");
      setAuthSession({ token, user, rememberMe });
      updateSession({ accessToken: token, user });
      setState((s) => ({ ...s, user }));
    },
    [state.token],
  );

  /** 改密码：后端验旧密码（403 INVALID_CURRENT_PASSWORD），前端不缓存任何密码状态 */
  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await apiClient.post("/auth/change-password", {
        current_password: currentPassword,
        new_password: newPassword,
      });
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await apiClient.post("/auth/logout");
    } catch {
      // Ignore errors — logout is best-effort
    }

    clearAuthSession();
    resetSession();
    setState({
      user: null,
      token: null,
      isLoading: false,
      isAuthenticated: false,
    });
    window.location.href = "/login";
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        register,
        setupAdmin,
        updateProfile,
        changePassword,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
