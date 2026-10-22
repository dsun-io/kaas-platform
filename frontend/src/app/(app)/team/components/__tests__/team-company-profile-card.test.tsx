/**
 * 团队与工位页 · 企业信息区块（2026-10-22 用户要求）。
 *
 * 钉住：
 * 1. 展示公司英文名 / 公司税号 / 英文开户行 / 配置状态；
 * 2. 团队管理员见「维护企业信息」入口（指向 /settings/company-profile）；
 * 3. 成员见只读提示（不给写入口），但仍能看字段；
 * 4. 区块不依赖公章接口（成员拉公章的列表会 403）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { TeamCompanyProfileCard } from "../team-company-profile-card";

const state = vi.hoisted(() => ({
  isTeamAdmin: true,
  loading: false,
  error: false,
  profile: {
    name_en: "ANPING KAAS WIRE MESH CO., LTD.",
    tax_id: "91131125MA0GA4242U",
    bank_name: "Bank of China, Anping Sub-branch",
    configured: true,
  } as Record<string, unknown> | null,
}));

vi.mock("@/lib/team/team-context", () => ({
  useTeam: () => ({ isTeamAdmin: state.isTeamAdmin }),
}));

vi.mock("../../../trade-docs/hooks/use-trade-docs", () => ({
  useCompanyProfile: () => ({
    data: state.profile,
    isLoading: state.loading,
    isError: state.error,
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<TeamCompanyProfileCard />));
}

function text(): string {
  return document.body.textContent ?? "";
}

function manageLink(): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(
    'a[href="/settings/company-profile"]',
  );
}

beforeEach(() => {
  state.isTeamAdmin = true;
  state.loading = false;
  state.error = false;
  state.profile = {
    name_en: "ANPING KAAS WIRE MESH CO., LTD.",
    tax_id: "91131125MA0GA4242U",
    bank_name: "Bank of China, Anping Sub-branch",
    configured: true,
  };
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("TeamCompanyProfileCard", () => {
  it("展示企业信息字段与配置状态", () => {
    mount();
    expect(text()).toContain("ANPING KAAS WIRE MESH CO., LTD.");
    expect(text()).toContain("91131125MA0GA4242U");
    expect(text()).toContain("Bank of China, Anping Sub-branch");
    expect(text()).toContain("已配置");
  });

  it("团队管理员见「维护企业信息」入口", () => {
    mount();
    expect(text()).toContain("维护企业信息");
    expect(manageLink()).not.toBeNull();
    expect(manageLink()?.getAttribute("href")).toBe(
      "/settings/company-profile",
    );
  });

  it("成员只读：没有维护入口，有联系管理员提示", () => {
    state.isTeamAdmin = false;
    mount();
    expect(text()).not.toContain("维护企业信息");
    expect(manageLink()).toBeNull();
    expect(text()).toContain("请联系团队管理员");
  });

  it("未配置时给出明显状态（单据抬头为空）", () => {
    state.profile = {
      name_en: null,
      tax_id: null,
      bank_name: null,
      configured: false,
    };
    mount();
    expect(text()).toContain("未配置");
  });

  it("不做公章列表请求（成员会 403）—— 组件只用 profile 一个查询", () => {
    // 本测试把 useCompanyProfile 之外的所有网络模块都 mock 掉了；
    // 若组件偷偷 import 了公章 hook，模块解析会失败（未 mock）⇒ 这里自然兜住。
    mount();
    expect(text()).toContain("企业信息");
  });
});
