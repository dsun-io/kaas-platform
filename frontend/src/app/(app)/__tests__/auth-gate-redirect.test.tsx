/**
 * AuthGate 登录跳转（2026-10-17 修复「先闪系统 UI 再弹登录」）。
 *
 * 钉死行为：
 * 1. **无凭据（无 has_token cookie）**：首帧不渲染系统 UI（只空壳占位），
 *    并 replace 到 /login（带 redirect 回跳参数）；
 * 2. **有凭据**：判定后挂载系统 UI（children）；
 * 3. 静态导出兼容：服务端首帧（无 document）也渲染空壳 —— 无 hydration mismatch。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import AppRouteLayout from "../layout";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  usePathname: () => "/customers",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/components/layout/app-layout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => (
    <div data-testid="system-ui">{children}</div>
  ),
}));
vi.mock("@/components/workstation-gate", () => ({
  WorkstationGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/team/team-context", () => ({
  TeamProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
}

async function settle(times = 3) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

function setCookies(cookie: string) {
  Object.defineProperty(document, "cookie", {
    value: cookie,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  unmount();
  // 还原 cookie mock
  Object.defineProperty(document, "cookie", {
    value: "",
    configurable: true,
    writable: true,
  });
});

describe("AuthGate 无凭据直跳登录（不闪系统 UI）", () => {
  it("无 cookie：首帧不渲染系统 UI，replace 到 /login", async () => {
    setCookies("");
    mount(
      <AppRouteLayout>
        <div data-testid="page-content">页面内容</div>
      </AppRouteLayout>,
    );
    // 首帧（effect 跑之前）就不得有系统 UI
    expect(container!.querySelector('[data-testid="system-ui"]')).toBeNull();
    expect(container!.querySelector('[data-testid="page-content"]')).toBeNull();
    expect(container!.textContent).toContain("正在验证登录状态");

    await settle();
    expect(mocks.replace).toHaveBeenCalledWith(
      `/login?redirect=${encodeURIComponent("/customers")}`,
    );
    // 跳转后依然没有渲染系统 UI
    expect(container!.querySelector('[data-testid="system-ui"]')).toBeNull();
  });

  it("有 cookie：判定后挂载系统 UI", async () => {
    setCookies("has_token=1");
    mount(
      <AppRouteLayout>
        <div data-testid="page-content">页面内容</div>
      </AppRouteLayout>,
    );
    await settle();
    expect(
      container!.querySelector('[data-testid="system-ui"]'),
    ).not.toBeNull();
    expect(
      container!.querySelector('[data-testid="page-content"]'),
    ).not.toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
