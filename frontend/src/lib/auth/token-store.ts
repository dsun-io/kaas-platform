/** localStorage / sessionStorage persistence for JWT + user info.
 *
 *  Convention:
 *  - rememberMe=true  → localStorage  (survives browser close, 30d cookie)
 *  - rememberMe=false → sessionStorage (cleared on tab close, session cookie)
 *
 *  Never store plaintext passwords.
 */

import type { UserInfo } from "./types";

const TOKEN_KEY = "kaas_token";
const USER_KEY = "kaas_user";

function isBrowser() {
  return typeof window !== "undefined";
}

// ── storage selection ──

function getStorage(): Storage | null {
  if (!isBrowser()) return null;
  // Prefer localStorage if token exists there; fall back to sessionStorage
  if (localStorage.getItem(TOKEN_KEY)) return localStorage;
  if (sessionStorage.getItem(TOKEN_KEY)) return sessionStorage;
  return localStorage; // default for writes
}

function getStorageBoth(): Storage[] {
  if (!isBrowser()) return [];
  return [localStorage, sessionStorage];
}

// ── token ──

export function setToken(token: string, rememberMe: boolean): void {
  if (!isBrowser()) return;
  const storage = rememberMe ? localStorage : sessionStorage;
  storage.setItem(TOKEN_KEY, token);
  // Clear from the other storage to avoid stale data
  const other = rememberMe ? sessionStorage : localStorage;
  other.removeItem(TOKEN_KEY);
  other.removeItem(USER_KEY);
}

export function getToken(): string | null {
  if (!isBrowser()) return null;
  return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY);
}

// ── user ──

export function setUser(user: UserInfo, rememberMe: boolean): void {
  if (!isBrowser()) return;
  const storage = rememberMe ? localStorage : sessionStorage;
  storage.setItem(USER_KEY, JSON.stringify(user));
  const other = rememberMe ? sessionStorage : localStorage;
  other.removeItem(USER_KEY);
}

export function getUser(): UserInfo | null {
  if (!isBrowser()) return null;
  for (const storage of [localStorage, sessionStorage]) {
    const raw = storage.getItem(USER_KEY);
    if (!raw) continue;
    try {
      return JSON.parse(raw) as UserInfo;
    } catch {
      storage.removeItem(USER_KEY);
    }
  }
  return null;
}

// ── combined session ──

export function setAuthSession(opts: {
  token: string;
  user: UserInfo;
  rememberMe: boolean;
}): void {
  setToken(opts.token, opts.rememberMe);
  setUser(opts.user, opts.rememberMe);
  setAuthCookie(opts.rememberMe);
}

export function clearAuthSession(): void {
  for (const storage of getStorageBoth()) {
    storage.removeItem(TOKEN_KEY);
    storage.removeItem(USER_KEY);
  }
  removeAuthCookie();
}

// ── cookie flag (Next.js middleware can't read localStorage) ──

export function setAuthCookie(rememberMe: boolean): void {
  if (typeof document === "undefined") return;
  const maxAge = rememberMe ? 2592000 : 0; // 30 days or session
  const parts = [`has_token=1`, `path=/`, `SameSite=Lax`];
  if (maxAge > 0) parts.push(`max-age=${maxAge}`);
  document.cookie = parts.join("; ");
}

export function removeAuthCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = "has_token=1; path=/; SameSite=Lax; max-age=0";
}
