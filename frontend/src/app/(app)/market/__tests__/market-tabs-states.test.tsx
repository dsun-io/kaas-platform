/**
 * U-P0B3（审计 §4 M4/M5）：产品市场对照五 tab「失败 ≠ 空态」。
 *
 * 钉死：
 *  1. 每个 tab 的查询失败 ⇒ ErrorState（role=alert）+ 后端原因 + 重试；
 *  2. UsageTab 加载中 ⇒ LoadingBlock（原来是整块空白）；
 *  3. 失败不被渲染成「暂无/未找到」文案。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
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

import { MarketView } from "../components/market-view";

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
        <MarketView />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function alertText() {
  return document.querySelector('[role="alert"]')?.textContent ?? null;
}

function clickTab(label: string) {
  const trigger = Array.from(
    container!.querySelectorAll("[data-slot='tabs-trigger']"),
  ).find((el) => (el.textContent ?? "").trim() === label);
  if (!trigger) throw new Error(`没找到 tab「${label}」`);
  act(() => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function retryButton() {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === "重试",
  );
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

describe("市场对照 · 地区查询", () => {
  it("地区列表加载中 ⇒ LoadingBlock；失败 ⇒ ErrorState + 重试", async () => {
    let regionCalls = 0;
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      if (String(url) === "/market/regions") {
        regionCalls += 1;
        if (regionCalls === 1) throw backendError("地区服务不可用");
        return ok(["CN"]);
      }
      return ok([]);
    });

    await mount();

    expect(alertText()).toContain("地区列表读取失败");
    expect(alertText()).toContain("地区服务不可用");
    expect(container!.textContent).not.toContain("暂无地区数据");

    await act(async () => {
      retryButton()!.click();
    });
    await settle();

    expect(regionCalls).toBe(2);
    expect(alertText()).toBeNull();
    expect(container!.textContent).toContain("CN");
  });

  it("选中地区后产品读取失败 ⇒ ErrorState（不是「该地区暂无产品数据」）", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/market/regions") return ok(["CN"]);
      if (path.startsWith("/market/regions/CN/products")) {
        throw backendError("地区产品服务不可用");
      }
      return ok([]);
    });

    await mount();
    // 点左侧地区按钮（CN）
    const regionButton = Array.from(container!.querySelectorAll("button")).find(
      (el) => (el.textContent ?? "").trim() === "CN",
    );
    expect(regionButton).toBeTruthy();
    await act(async () => {
      regionButton!.click();
    });
    await settle();

    expect(alertText()).toContain("该地区产品读取失败");
    expect(alertText()).toContain("地区产品服务不可用");
    expect(container!.textContent).not.toContain("该地区暂无产品数据");
  });
});

describe("市场对照 · 其余四个 tab", () => {
  it("品名 / 用途 / 港口 / 品名对照 查询失败都显示 ErrorState（且 UsageTab 加载有 LoadingBlock）", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/market/regions") return ok([]);
      if (path.startsWith("/market/name-lookup")) {
        throw backendError("品名服务不可用");
      }
      if (path === "/market/usages") throw backendError("用途服务不可用");
      if (path.startsWith("/market/ports"))
        throw backendError("港口服务不可用");
      return ok([]);
    });

    await mount();

    // 品名查询
    clickTab("按品名查询");
    await settle(2);
    const productInput = container!.querySelector(
      'input[placeholder^="输入品名"]',
    ) as HTMLInputElement;
    setInputValue(productInput, "chain link fence");
    await settle();
    expect(alertText()).toContain("品名查询失败");
    expect(alertText()).toContain("品名服务不可用");
    expect(container!.textContent).not.toContain("未找到匹配品名");

    // 用途查询（失败 → ErrorState）
    clickTab("按用途查询");
    await settle();
    expect(alertText()).toContain("用途分类读取失败");
    expect(alertText()).toContain("用途服务不可用");
    expect(container!.textContent).not.toContain("暂无用途分类数据");

    // 港口情报
    clickTab("港口情报");
    await settle();
    expect(alertText()).toContain("港口数据读取失败");
    expect(alertText()).toContain("港口服务不可用");
    expect(container!.textContent).not.toContain("暂无港口数据");

    // 品名对照
    clickTab("品名对照");
    await settle(2);
    const nameInput = container!.querySelector(
      'input[aria-label="搜索品名对照"]',
    ) as HTMLInputElement;
    setInputValue(nameInput, "勾花网");
    await settle();
    expect(alertText()).toContain("品名对照查询失败");
    expect(alertText()).toContain("品名服务不可用");
  });

  it("UsageTab 加载中显示 LoadingBlock（原来整块空白）", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/market/regions") return ok([]);
      if (path === "/market/usages") {
        return new Promise<GetResp>(() => {}) as never;
      }
      return ok([]);
    });

    await mount();
    clickTab("按用途查询");
    await settle();

    expect(
      document.querySelector('[aria-busy="true"][aria-label="加载中"]'),
    ).not.toBeNull();
    expect(alertText()).toBeNull();
  });
});
