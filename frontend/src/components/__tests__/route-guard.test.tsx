/**
 * 路由守卫口径（2026-10-20 前后端对齐审计 P2-6）。
 *
 * 钉死行为：
 *   1. `adminOnly` = **internal 账号 + 管理员角色**（后端 `_require_platform_ops` 同口径），
 *      internal 非管理员**也要被拦**（此前只判 account_type ⇒ 打开后接口全 403）；
 *   2. customer 用户行为不变（adminOnly / internalOnly 都拦；普通页放行）；
 *   3. `internalOnly` = 仅内部账号可见（给"后端无管理员闸门、只需内部账号"的页面留的入口，
 *      当前无页面启用：/kb 属此类，但它的目录不在本次改动范围）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const authState = vi.hoisted(() => ({
  user: null as {
    account_type?: string;
    role?: string;
  } | null,
}));

vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ user: authState.user }),
}));

// RouteGuard 的无权限兜底含"返回工作台"链接；jsdom 里没有 App Router 上下文，
// next/link 直接渲染会抛错 ⇒ 用原生 a 替身（只关心 href/文案）。
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string | { pathname?: string };
    children: ReactNode;
  }) => (
    <a href={typeof href === "string" ? href : (href?.pathname ?? "#")}>
      {children}
    </a>
  ),
}));

import { RouteGuard, isPlatformOperator } from "../route-guard";

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

function text(): string {
  return container?.textContent ?? "";
}

beforeEach(() => {
  authState.user = null;
});

afterEach(() => {
  unmount();
});

describe("isPlatformOperator（与后端 _require_platform_ops 同口径）", () => {
  it("internal + system_admin / admin → true", () => {
    expect(
      isPlatformOperator({ account_type: "internal", role: "system_admin" }),
    ).toBe(true);
    // 历史角色 admin 等价 system_admin（scope.effective_role）
    expect(
      isPlatformOperator({ account_type: "internal", role: "admin" }),
    ).toBe(true);
  });

  it("internal 非管理员 / customer / 未登录 → false", () => {
    expect(isPlatformOperator({ account_type: "internal", role: "user" })).toBe(
      false,
    );
    expect(
      isPlatformOperator({ account_type: "customer", role: "system_admin" }),
    ).toBe(false);
    expect(isPlatformOperator(null)).toBe(false);
    expect(isPlatformOperator(undefined)).toBe(false);
  });
});

describe("RouteGuard adminOnly", () => {
  it("customer → 拦（行为不变）", () => {
    authState.user = { account_type: "customer", role: "owner" };
    mount(
      <RouteGuard adminOnly>
        <div data-testid="member-only">管理员内容</div>
      </RouteGuard>,
    );
    expect(text()).toContain("您没有访问此页面的权限");
    expect(container!.querySelector('[data-testid="member-only"]')).toBeNull();
  });

  it("无权限兜底保留页头 + role=alert + 返回入口（A1）", () => {
    authState.user = { account_type: "customer", role: "owner" };
    mount(
      <RouteGuard adminOnly>
        <div>管理员内容</div>
      </RouteGuard>,
    );
    expect(container!.querySelector("h1")?.textContent).toBe("无权限访问");
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      "您没有访问此页面的权限",
    );
    const back = container!.querySelector('a[href="/"]');
    expect(back?.textContent).toContain("返回工作台");
  });

  it("internal 非管理员 → 拦（本次收紧：后端会 403）", () => {
    authState.user = { account_type: "internal", role: "user" };
    mount(
      <RouteGuard adminOnly>
        <div data-testid="member-only">管理员内容</div>
      </RouteGuard>,
    );
    expect(text()).toContain("您没有访问此页面的权限");
  });

  it("internal 管理员（system_admin）→ 放行", () => {
    authState.user = { account_type: "internal", role: "system_admin" };
    mount(
      <RouteGuard adminOnly>
        <div data-testid="member-only">管理员内容</div>
      </RouteGuard>,
    );
    expect(
      container!.querySelector('[data-testid="member-only"]'),
    ).not.toBeNull();
  });

  it("自定义 fallback 优先生效", () => {
    authState.user = { account_type: "customer", role: "owner" };
    mount(
      <RouteGuard
        adminOnly
        fallback={<p data-testid="custom-fallback">无权限</p>}
      >
        <div>管理员内容</div>
      </RouteGuard>,
    );
    expect(
      container!.querySelector('[data-testid="custom-fallback"]'),
    ).not.toBeNull();
    expect(text()).not.toContain("管理员内容");
  });
});

describe("RouteGuard 非 adminOnly（普通页）行为不变", () => {
  it("customer 放行", () => {
    authState.user = { account_type: "customer", role: "owner" };
    mount(
      <RouteGuard>
        <div data-testid="page">普通页面</div>
      </RouteGuard>,
    );
    expect(container!.querySelector('[data-testid="page"]')).not.toBeNull();
  });
});

describe("RouteGuard internalOnly（仅内部账号可见，不要求管理员）", () => {
  it("internal 非管理员 → 放行（不随 adminOnly 收紧）", () => {
    authState.user = { account_type: "internal", role: "user" };
    mount(
      <RouteGuard internalOnly>
        <div data-testid="kb">知识库</div>
      </RouteGuard>,
    );
    expect(container!.querySelector('[data-testid="kb"]')).not.toBeNull();
  });

  it("customer → 拦", () => {
    authState.user = { account_type: "customer", role: "owner" };
    mount(
      <RouteGuard internalOnly>
        <div data-testid="kb">知识库</div>
      </RouteGuard>,
    );
    expect(text()).toContain("您没有访问此页面的权限");
  });
});
