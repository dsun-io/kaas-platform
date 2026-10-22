/**
 * 汇率历史卡片（C36 下期 #5）——GET /fx-rates 裸数组、过滤参数、上限提示与错误态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { FxHistoryCard } from "../fx-history-card";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get },
  apiClient: { get: mocks.get },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROWS = [
  {
    base_currency: "USD",
    quote_currency: "CNY",
    rate: 6.7029,
    rate_date: "2026-10-21",
    source: "manual",
    is_stale: false,
  },
  {
    base_currency: "USD",
    quote_currency: "CNY",
    rate: 6.71,
    rate_date: "2026-10-20",
    source: "external",
    is_stale: true,
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: ROWS });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
});

describe("FxHistoryCard", () => {
  it("按 base/quote/limit 请求，展示日期/币种对/来源与过期标记", async () => {
    mount(<FxHistoryCard />);
    await settle();

    expect(mocks.get).toHaveBeenCalledWith("/fx-rates", {
      params: { base_currency: "USD", quote_currency: "CNY", limit: 30 },
      silent: true,
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("2026-10-21");
    expect(text).toContain("6.7029");
    expect(text).toContain("手工录入");
    expect(text).toContain("备用数据（外部汇率源暂不可用）");
    expect(text).toContain("最多 365 条");
  });

  it("切换条数后按新 limit 重新请求（上限 365 由 hook 夹紧）", async () => {
    mount(<FxHistoryCard />);
    await settle();
    mocks.get.mockClear();

    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="历史条数"]',
    );
    if (!select) throw new Error("没找到条数选择");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(select, "365");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();

    expect(mocks.get).toHaveBeenCalledWith("/fx-rates", {
      params: { base_currency: "USD", quote_currency: "CNY", limit: 365 },
      silent: true,
    });
  });

  it("空历史给出可执行提示（外部源首次刷新/手工录入）", async () => {
    mocks.get.mockResolvedValue({ data: [] });
    mount(<FxHistoryCard />);
    await settle();
    expect(document.body.textContent).toContain("还没有历史记录");
  });

  it("读取失败时显示原因", async () => {
    mocks.get.mockRejectedValue(
      Object.assign(new Error("Service Unavailable"), {
        response: {
          status: 503,
          data: { detail: { error: "fx_refresh_failed", detail: "外部源不可用" } },
        },
      }),
    );
    mount(<FxHistoryCard />);
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "外部源不可用",
    );
  });
});
