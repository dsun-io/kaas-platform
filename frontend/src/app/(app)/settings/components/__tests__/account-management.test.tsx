/**
 * 平台账号管理组件（`account-management.tsx`）—— 无后端组件测试。
 *
 * 覆盖口径（交接文档 §④ 已定稿）：
 * 1. 列表渲染白名单列（邮箱/显示名/账号类型/角色/状态/团队/创建时间）；
 * 2. 停用前二次确认弹窗（无法登录 / 可随时恢复 / 不删历史数据）；
 * 3. PATCH status 正确发出、成功后刷新列表；
 * 4. 409 SELF_PROTECT / LAST_ADMIN → 页内 role=alert 明确文案；403 → 无权限
 *    （apiClient 拦截器已 toast，页面不再重复弹 toast）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AccountManagement } from "../account-management";

// default 与 named 导出必须是**同一个** mock 实例 —— 组件用 named `apiClient`，
// 测试里配置的若是 default 那份，组件拿到的是未配置的 vi.fn()（返回 undefined → 查询报错）。
const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, patch: mocks.patch },
  apiClient: { get: mocks.get, patch: mocks.patch },
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = {
  id: 9,
  email: "u9@qa.test",
  display_name: "用户9",
  account_type: "internal",
  role: "customer_member",
  status: "active",
  team_id: 5,
  team_name: "联佳丝网",
  console_access: false,
  created_at: "2026-10-01T08:00:00.000Z",
  updated_at: "2026-10-01T08:00:00.000Z",
};

type GetResp = { data: unknown };
const ok = (data: unknown): GetResp => ({ data }) as unknown as GetResp;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

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
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>,
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
}

function alertText(): string {
  return document.querySelector('[role="alert"]')?.textContent ?? "";
}

function clickButton(text: string, scope: ParentNode = document) {
  const buttons = Array.from(scope.querySelectorAll("button"));
  const target = buttons.find(
    (b) => b.textContent?.replace("…", "").trim() === text,
  );
  if (!target) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(ok({ accounts: [ACCOUNT], total: 1 }));
});

afterEach(() => {
  unmount();
});

describe("AccountManagement", () => {
  it("渲染白名单列与账号行（不含敏感字段）", async () => {
    mount(<AccountManagement />);
    await settle();
    const text = document.body.textContent ?? "";
    for (const col of [
      "邮箱",
      "显示名",
      "账号类型",
      "角色",
      "状态",
      "团队",
      "创建时间",
    ]) {
      expect(text).toContain(col);
    }
    expect(text).toContain("u9@qa.test");
    expect(text).toContain("联佳丝网");
    expect(text).not.toContain("password_hash");
    expect(text).not.toContain("token");
  });

  it("停用需二次确认：弹窗说明后果，确认后才 PATCH disabled", async () => {
    let patched: unknown = null;
    mocks.patch.mockImplementation(((_url: string, body: unknown) => {
      patched = body;
      return Promise.resolve(
        ok({ account: { ...ACCOUNT, status: "disabled" } }),
      ) as unknown as Promise<GetResp>;
    }) as never);

    mount(<AccountManagement />);
    await settle();

    clickButton("停用");
    await settle();
    const dialogText = document.body.textContent ?? "";
    expect(dialogText).toContain("将无法登录");
    expect(dialogText).toContain("可随时恢复");
    expect(dialogText).toContain("不会删除历史数据");
    // 尚未 PATCH
    expect(patched).toBeNull();

    clickButton("确认停用");
    await settle();
    expect(patched).toEqual({ status: "disabled" });
    expect(mocks.patch.mock.calls[0]?.[0]).toBe("/admin/accounts/9");
  });

  it("已停用账号显示「恢复」按钮并 PATCH active", async () => {
    mocks.get.mockResolvedValue(
      ok({ accounts: [{ ...ACCOUNT, status: "disabled" }], total: 1 }),
    );
    let patched: unknown = null;
    mocks.patch.mockImplementation(((_url: string, body: unknown) => {
      patched = body;
      return Promise.resolve(
        ok({ account: ACCOUNT }),
      ) as unknown as Promise<GetResp>;
    }) as never);

    mount(<AccountManagement />);
    await settle();
    clickButton("恢复");
    await settle();
    expect(patched).toEqual({ status: "active" });
  });

  it("409 SELF_PROTECT → 明确文案阻止", async () => {
    mocks.patch.mockRejectedValue({
      response: {
        status: 409,
        data: { detail: { error: "conflict", code: "SELF_PROTECT" } },
      },
      message: "Request failed with status code 409",
    });

    mount(<AccountManagement />);
    await settle();
    clickButton("停用");
    await settle();
    clickButton("确认停用");
    await settle();
    expect(alertText()).toContain("不能停用当前登录的账号");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("409 LAST_ADMIN → 明确文案阻止", async () => {
    mocks.patch.mockRejectedValue({
      response: {
        status: 409,
        data: { detail: { error: "conflict", code: "LAST_ADMIN" } },
      },
      message: "Request failed with status code 409",
    });

    mount(<AccountManagement />);
    await settle();
    clickButton("停用");
    await settle();
    clickButton("确认停用");
    await settle();
    expect(alertText()).toContain("至少保留一名系统管理员");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("403 → 无权限文案", async () => {
    mocks.patch.mockRejectedValue({
      response: { status: 403, data: { detail: { error: "forbidden" } } },
      message: "Request failed with status code 403",
    });

    mount(<AccountManagement />);
    await settle();
    clickButton("停用");
    await settle();
    clickButton("确认停用");
    await settle();
    expect(alertText()).toContain("无权限执行此操作");
    expect(toastError).not.toHaveBeenCalled();
  });
});
