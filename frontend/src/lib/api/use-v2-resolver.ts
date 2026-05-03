/**
 * X-Use-V2  header resolver — 4-level priority per §11.10.
 *
 * Priority chain:
 *   1. URL query param  ?use_v2=true|false
 *   2. localStorage key  kaas:use_v2
 *   3. Session flag      session.featureFlags.use_v2
 *   4. Env default       NEXT_PUBLIC_USE_V2_DEFAULT
 */

const STORAGE_KEY = 'kaas:use_v2';

function fromUrlQuery(): boolean | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const v = params.get('use_v2');
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function fromLocalStorage(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'true') return true;
    if (v === 'false') return false;
  } catch {
    // localStorage may be blocked (private mode)
  }
  return null;
}

function fromSessionFlag(): boolean | null {
  // Phase 0: no session feature flags available
  return null;
}

function fromEnvDefault(): boolean {
  return process.env.NEXT_PUBLIC_USE_V2_DEFAULT === 'true';
}

export function resolveUseV2(): boolean {
  const url = fromUrlQuery();
  if (url !== null) return url;

  const storage = fromLocalStorage();
  if (storage !== null) return storage;

  const session = fromSessionFlag();
  if (session !== null) return session;

  return fromEnvDefault();
}

export function setLocalUseV2(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // silently ignore in private mode
  }
}
