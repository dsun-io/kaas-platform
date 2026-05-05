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
  setToken,
  removeToken,
  getUser,
  setUser,
  removeUser,
  setAuthCookie,
  removeAuthCookie,
} from "./token-store";
import type { UserInfo, AuthState } from "./types";

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    isLoading: true,
    isAuthenticated: false,
  });

  // On mount: try to restore session from localStorage
  useEffect(() => {
    const restore = async () => {
      const token = getToken();
      if (!token) {
        setState((s) => ({ ...s, isLoading: false }));
        return;
      }

      try {
        const res = await apiClient.get("/auth/me");
        const user = res.data as UserInfo;
        setToken(token);
        setUser(user);
        updateSession({ accessToken: token, user });
        setState({ user, token, isLoading: false, isAuthenticated: true });
      } catch {
        // Token expired or invalid — clear silently
        removeToken();
        removeUser();
        removeAuthCookie();
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
    async (email: string, password: string) => {
      const res = await apiClient.post("/auth/login", { email, password });
      const data = res.data;
      const user: UserInfo = {
        user_id: data.user_id,
        email: data.email,
        display_name: data.display_name,
        account_type: data.account_type,
        customer_id: data.customer_id ?? null,
        customer_code: data.customer_code ?? null,
        customer_name: data.customer_name ?? null,
        tenant_id: data.tenant_id ?? null,
      };
      const token: string = data.access_token;

      setToken(token);
      setUser(user);
      setAuthCookie();
      updateSession({ accessToken: token, user });

      setState({ user, token, isLoading: false, isAuthenticated: true });

      const redirect = safeRedirect(searchParams.get("redirect"));
      window.location.href = redirect;
    },
    [searchParams],
  );

  const logout = useCallback(async () => {
    try {
      await apiClient.post("/auth/logout");
    } catch {
      // Ignore errors — logout is best-effort
    }

    removeToken();
    removeUser();
    removeAuthCookie();
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
    <AuthContext.Provider value={{ ...state, login, logout }}>
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
