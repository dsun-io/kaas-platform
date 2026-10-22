/**
 * U-P0B3（审计 §4 I1/I2）：情报工位四视图「失败 ≠ 空态」。
 *
 * 钉死：
 *  1. 货运记录失败 ⇒ ErrorState + 后端原因 + 重试（不是「暂无货运记录数据」）；
 *  2. 加载中 ⇒ LoadingBlock；
 *  3. 贸易统计 / 数据渠道 / 采集任务三视图失败同样 ErrorState，不落成「暂无…」。
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

import { AdapterRunsList } from "../components/adapter-runs-list";
import { ChannelsView } from "../components/channels-view";
import { IntelSection } from "../components/intel-section";
import { TradeStatsView } from "../components/trade-stats-view";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

function backendError(message: string) {
  return {
    response: {
      status: 500,
      data: { detail: { error: "internal", code: "INTERNAL", message } },
    },
  };
}

const EMPTY_SHIPMENTS = { items: [], total: 0, page: 1, page_size: 20 };

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

async function mount(element: ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>,
    ),
  );
  await settle();
}

function alertText() {
  return document.querySelector('[role="alert"]')?.textContent ?? null;
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("情报 · 货运记录", () => {
  it("失败 ⇒ ErrorState + 重试，不显示「暂无货运记录数据」", async () => {
    vi.mocked(apiClient.get)
      .mockRejectedValueOnce(backendError("货运数据服务不可用"))
      .mockResolvedValue(ok(EMPTY_SHIPMENTS) as never);

    await mount(<IntelSection />);

    expect(alertText()).toContain("货运记录读取失败");
    expect(alertText()).toContain("货运数据服务不可用");
    expect(container!.textContent).not.toContain("暂无货运记录数据");

    const retry = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "重试",
    );
    await act(async () => {
      retry!.click();
    });
    await settle();

    expect(alertText()).toBeNull();
    expect(container!.textContent).toContain("暂无货运记录数据");
  });

  it("加载中 ⇒ LoadingBlock", async () => {
    vi.mocked(apiClient.get).mockImplementation(
      () => new Promise<GetResp>(() => {}) as never,
    );

    await mount(<IntelSection />);

    expect(
      document.querySelector('[aria-busy="true"][aria-label="加载中"]'),
    ).not.toBeNull();
    expect(alertText()).toBeNull();
  });
});

describe("情报 · 其余三视图", () => {
  it("贸易统计失败 ⇒ ErrorState（不是「暂无贸易统计数据」）", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(
      backendError("统计数据服务不可用"),
    );

    await mount(<TradeStatsView />);

    expect(alertText()).toContain("贸易统计读取失败");
    expect(alertText()).toContain("统计数据服务不可用");
    expect(container!.textContent).not.toContain("暂无贸易统计数据");
  });

  it("数据渠道失败 ⇒ ErrorState（不是「暂无免费渠道数据」）", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(backendError("渠道服务不可用"));

    await mount(<ChannelsView />);

    expect(alertText()).toContain("数据渠道读取失败");
    expect(alertText()).toContain("渠道服务不可用");
    expect(container!.textContent).not.toContain("暂无免费渠道数据");
  });

  it("采集任务失败 ⇒ ErrorState（不是「暂无采集任务记录」）", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(backendError("任务服务不可用"));

    await mount(<AdapterRunsList />);

    expect(alertText()).toContain("采集任务读取失败");
    expect(alertText()).toContain("任务服务不可用");
    expect(container!.textContent).not.toContain("暂无采集任务记录");
  });

  it("数据渠道加载中 ⇒ LoadingBlock", async () => {
    vi.mocked(apiClient.get).mockImplementation(
      () => new Promise<GetResp>(() => {}) as never,
    );

    await mount(<ChannelsView />);

    expect(
      document.querySelector('[aria-busy="true"][aria-label="加载中"]'),
    ).not.toBeNull();
  });
});
