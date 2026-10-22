/**
 * U-P0B3（审计 §4 E1）：事件列表「失败 ≠ 空态」。
 *
 * 钉死：
 *  1. 请求失败 ⇒ ErrorState（role=alert）+ 后端原因 + 重试，**不能**显示「暂无事件数据」；
 *  2. 加载中 ⇒ LoadingBlock（aria-busy/aria-label 加载中）；
 *  3. 点重试确实重新请求（不是死按钮）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", () => {
  const client = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { default: client, apiClient: client };
});
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));

import EventsPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

/** axios 错误外形（normalizeApiError 认 response.data.detail.message） */
function backendError(message: string) {
  return {
    response: {
      status: 500,
      data: { detail: { error: "internal", code: "INTERNAL", message } },
    },
  };
}

const EMPTY_PAGE = { items: [], total: 0, page: 1, page_size: 20 };

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

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>
        <EventsPage />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function alertText() {
  return document.querySelector('[role="alert"]')?.textContent ?? null;
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("事件列表三态（失败≠空态）", () => {
  it("失败显示 ErrorState + 原因 + 重试，不显示「暂无事件数据」", async () => {
    vi.mocked(apiClient.get)
      .mockRejectedValueOnce(backendError("数据库连接失败"))
      .mockResolvedValue(ok(EMPTY_PAGE) as never);

    await mount();

    const text = alertText();
    expect(text).not.toBeNull();
    expect(text).toContain("事件读取失败");
    expect(text).toContain("数据库连接失败");
    expect(container!.textContent).not.toContain("暂无事件数据");

    const retry = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "重试",
    );
    expect(retry).toBeTruthy();
    await act(async () => {
      retry!.click();
    });
    await settle();

    // 重试确实重新请求；成功后错误态消失、换成真正的空态
    expect(vi.mocked(apiClient.get).mock.calls.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(alertText()).toBeNull();
    expect(container!.textContent).toContain("暂无事件数据");
  });

  it("加载中显示 LoadingBlock（aria-busy + 加载中）", async () => {
    vi.mocked(apiClient.get).mockImplementation(
      () => new Promise<GetResp>(() => {}) as never,
    );

    await mount();

    const loading = document.querySelector(
      '[aria-busy="true"][aria-label="加载中"]',
    );
    expect(loading).not.toBeNull();
    expect(alertText()).toBeNull();
    expect(container!.textContent).not.toContain("暂无事件数据");
  });
});
