/**
 * 通知铃铛：未读角标 / 抽屉列表 / 单条已读 / 全部已读 / 深链跳转。
 *
 * 轮询参数（60s + refetchIntervalInBackground: true）在
 * `lib/approvals/use-notifications.ts` 里由 query 选项显式固定 —— 这里验证行为，
 * 不重复断言 React Query 内部实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

const pushMock = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/lib/api/client", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { NotificationBell } from "../notification-bell";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
type PostResp = Awaited<ReturnType<typeof apiClient.post>>;
const okGet = (data: unknown) => ({ data }) as unknown as GetResp;
const okPost = (data: unknown) => ({ data }) as unknown as PostResp;

function notification(id: number, patch: Record<string, unknown> = {}) {
  return {
    id,
    type: "approval_requested",
    title: `待审批通知 ${id}`,
    body: "订单 SO-202610-0009 的明细变更待审批",
    link: `/approvals?focus=${id}`,
    ref_type: "order_item_change_request",
    ref_id: id,
    read_at: null,
    created_at: "2026-10-22T10:00:00+08:00",
    ...patch,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function trigger(): HTMLButtonElement {
  const button = container!.querySelector("button") as HTMLButtonElement | null;
  if (!button) throw new Error("没找到铃铛按钮");
  return button;
}

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (el) => (el.textContent ?? "").trim() === label,
  );
  if (!button) throw new Error(`没找到按钮「${label}」`);
  return button;
}

function click(element: HTMLButtonElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function mount(unread = 3) {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>
        <NotificationBell />
      </QueryClientProvider>,
    ),
  );
  await settle();
  void unread;
}

beforeEach(() => {
  vi.resetAllMocks();
  pushMock.mockClear();
  toastSuccess.mockClear();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/notifications/unread-count") return okGet({ unread: 3 });
    if (path === "/notifications") {
      return okGet({
        items: [
          notification(1),
          notification(2, {
            type: "approval_approved",
            title: "变更申请已批准",
            link: "/orders?id=9",
            read_at: "2026-10-22T11:00:00+08:00",
          }),
        ],
        total: 2,
        page: 1,
        page_size: 20,
      });
    }
    return okGet({ items: [], total: 0, page: 1, page_size: 20 });
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("通知铃铛", () => {
  it("未读数进角标与可访问名称（0 时不渲染角标）", async () => {
    await mount();
    expect(trigger().getAttribute("aria-label")).toBe("通知（3 条未读）");
    expect(trigger().textContent).toContain("3");

    // 未读为 0：角标消失，按钮名退回「通知」
    if (root) act(() => root!.unmount());
    container?.remove();
    document.body.innerHTML = "";
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      if (String(url) === "/notifications/unread-count")
        return okGet({ unread: 0 });
      return okGet({ items: [], total: 0, page: 1, page_size: 20 });
    });
    await mount(0);
    expect(trigger().getAttribute("aria-label")).toBe("通知");
    expect(trigger().textContent).not.toContain("3");
  });

  it("打开抽屉才拉列表；显示条目类型/时间/未读标记", async () => {
    await mount();
    const listCallsBefore = vi
      .mocked(apiClient.get)
      .mock.calls.filter(([url]) => String(url) === "/notifications");
    expect(listCallsBefore).toHaveLength(0);

    click(trigger());
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("待审批通知 1");
    expect(text).toContain("变更申请已批准");
    expect(text).toContain("2026-10-22 10:00");
    expect(text).toContain("未读");
  });

  it("单条点击：先 POST read 再按后端 link 深链", async () => {
    vi.mocked(apiClient.post).mockResolvedValue(
      okPost(notification(1, { read_at: "2026-10-22T12:00:00+08:00" })),
    );
    await mount();
    click(trigger());
    await settle();

    const item = Array.from(document.querySelectorAll("button")).find((el) =>
      (el.textContent ?? "").includes("待审批通知 1"),
    );
    if (!item) throw new Error("没找到通知条目");
    click(item as HTMLButtonElement);
    await settle(6);

    expect(vi.mocked(apiClient.post)).toHaveBeenCalledWith(
      "/notifications/1/read",
      {},
      { silent: true },
    );
    expect(pushMock).toHaveBeenCalledWith("/approvals?focus=1");
  });

  it("不安全 link 回落到 /approvals（不让后端脏数据成为跳转目标）", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/notifications/unread-count") return okGet({ unread: 1 });
      if (path === "/notifications") {
        return okGet({
          items: [
            notification(5, {
              link: "//evil.com/steal",
              read_at: "2026-10-22T11:00:00+08:00",
            }),
          ],
          total: 1,
          page: 1,
          page_size: 20,
        });
      }
      return okGet({ items: [], total: 0, page: 1, page_size: 20 });
    });
    await mount();
    click(trigger());
    await settle();

    const item = Array.from(document.querySelectorAll("button")).find((el) =>
      (el.textContent ?? "").includes("待审批通知 5"),
    );
    if (!item) throw new Error("没找到通知条目");
    click(item as HTMLButtonElement);
    await settle(6);

    expect(pushMock).toHaveBeenCalledWith("/approvals");
  });

  it("全部已读：POST /notifications/read-all 并提示清理条数", async () => {
    vi.mocked(apiClient.post).mockResolvedValue(okPost({ marked: 2 }));
    await mount();
    click(trigger());
    await settle();

    click(buttonByText("全部已读"));
    await settle(6);

    expect(vi.mocked(apiClient.post)).toHaveBeenCalledWith(
      "/notifications/read-all",
      {},
      { silent: true },
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("2 条通知"),
    );
  });
});
