/** localStorage persistence for JWT + user info */

import type { UserInfo } from "./types";

const TOKEN_KEY = "kaas_token";
const USER_KEY = "kaas_user";

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function removeToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
}

export function setUser(user: UserInfo): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getUser(): UserInfo | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserInfo;
  } catch {
    return null;
  }
}

export function removeUser(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(USER_KEY);
}

// Cookie flag for Next.js middleware (cannot read localStorage)
export function setAuthCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = "has_token=1; path=/; SameSite=Lax; max-age=86400";
}

export function removeAuthCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = "has_token=1; path=/; SameSite=Lax; max-age=0";
}
