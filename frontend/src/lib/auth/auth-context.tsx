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
  return "/dashboard";
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
    customer_id: (data.customer_id as number) ?? null,
    customer_code: (data.customer_code as string) ?? null,
    customer_name: (data.customer_name as string) ?? null,
    tenant_id: (data.tenant_id as string) ?? null,
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
      value={{ ...state, login, register, setupAdmin, logout }}
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
