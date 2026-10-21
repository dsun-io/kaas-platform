/**
 * 平台管理端「团队管理」页（`/admin/teams`）—— 无后端组件测试。
 *
 * 覆盖口径：
 * 1. 渲染 2 行团队，断言团队名 / 创建者 / 成员数 / 已开通工位数；
 * 2. 数据层确实请求 `GET /teams`（silent，平台全量列表）；
 * 3. 空 items → 显示空态文案（不是白屏、不是错误）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import AdminTeamsPage from "../page";

// default 与 named 导出必须是**同一个** mock 实例 —— 页面数据层用 default apiClient。
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  adminUser: {
    user_id: 1,
    email: "admin@kaas.local",
    display_name: "平台管理员",
    account_type: "internal",
    role: "system_admin",
    plan: "enterprise",
    team_id: null,
    team_name: null,
    console_access: true,
  },
}));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get },
  apiClient: { get: mocks.get },
}));

// RouteGuard / 页面都读登录态；AuthProvider 依赖 next/navigation（jsdom 下没有 App Router），
// 所以直接 mock 成固定系统管理员。
vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({
    user: mocks.adminUser,
    token: "mock-token",
    isLoading: false,
    isAuthenticated: true,
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

// 页面浏览事件会发 POST /events，与本用例无关，避免噪音。
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TEAMS = [
  {
    id: 1,
    name: "系统管理员团队",
    created_by: 4,
    created_by_email: "david@powervoy.com",
    created_by_name: "David / 系统管理员",
    member_count: 1,
    workstation_count: 0,
    workstation_codes: [],
    created_at: "2026-10-01T08:00:00.000Z",
  },
  {
    id: 2,
    name: "联佳丝网",
    created_by: 2,
    created_by_email: "ops@kaas.local",
    created_by_name: "运营小李",
    member_count: 3,
    workstation_count: 2,
    workstation_codes: ["research", "customers"],
    created_at: "2026-10-08T08:00:00.000Z",
  },
];

const ok = (data: unknown) => ({ data }) as never;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(times = 3) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(ok({ items: TEAMS, total: TEAMS.length }));
});

afterEach(() => {
  unmount();
});

describe("AdminTeamsPage", () => {
  it("渲染团队列表：团队名 / 创建者 / 成员数 / 已开通工位数", async () => {
    mount(<AdminTeamsPage />);
    await settle();

    const rows = Array.from(document.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(2);

    const first = rows[0]?.textContent ?? "";
    expect(first).toContain("系统管理员团队");
    expect(first).toContain("David / 系统管理员");
    expect(first).toContain("david@powervoy.com");
    expect(first).toContain("1 人");
    expect(first).toContain("0 个");

    const second = rows[1]?.textContent ?? "";
    expect(second).toContain("联佳丝网");
    expect(second).toContain("运营小李");
    expect(second).toContain("3 人");
    expect(second).toContain("2 个");
  });

  it("数据层请求 GET /teams（silent）", async () => {
    mount(<AdminTeamsPage />);
    await settle();
    expect(mocks.get).toHaveBeenCalledWith("/teams", { silent: true });
  });

  it("空列表 → 显示空态文案", async () => {
    mocks.get.mockResolvedValue(ok({ items: [], total: 0 }));
    mount(<AdminTeamsPage />);
    await settle();
    expect(document.body.textContent).toContain("暂无团队");
  });
});
