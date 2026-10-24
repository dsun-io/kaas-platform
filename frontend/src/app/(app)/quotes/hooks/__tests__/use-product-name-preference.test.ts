/**
 * 客户 × 产品英文名偏好 hook（A 项 2026-10-24）。
 *
 * 只钉接线：请求路径/参数对不对、要等 customer_id + product_key 都有才发请求。
 * 语义（最近一条行项 / 旧行名称回落）在内核与 MSW 两侧，这里不重复测。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

import { useProductNamePreference } from "../use-product-name-preference";

vi.mock("@/lib/api/client", () => ({
  default: { get: vi.fn() },
  apiClient: { get: vi.fn() },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** 用 createRoot + act 渲染 hook（仓库没装 testing-library，风格同 use-export-products.test） */
function renderHook<T>(useHook: () => T) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const ref: { current: T | null } = { current: null };

  function Probe() {
    ref.current = useHook();
    return null;
  }

  act(() => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Probe)),
    );
  });

  function hook() {
    const h = ref.current;
    if (!h) throw new Error("hook 还没渲染出来");
    return h;
  }

  return {
    hook,
    async settle(times = 3) {
      await act(async () => {
        for (let i = 0; i < times; i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
      });
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
      client.clear();
    },
  };
}

describe("useProductNamePreference", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("customer_id + product_key 都有 → 按两者查询并返回偏好名", async () => {
    const get = vi.mocked(apiClient.get);
    get.mockResolvedValue({
      data: { product_name: "Field Fence" },
    } as never);

    const view = renderHook(() => useProductNamePreference("1", "field_fence"));
    await view.settle();

    expect(view.hook().data).toEqual({ product_name: "Field Fence" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(String(get.mock.calls[0]![0])).toBe(
      "/quotes/product-name-preference",
    );
    const config = get.mock.calls[0]![1] as {
      params?: Record<string, unknown>;
      silent?: boolean;
    };
    expect(config.params).toEqual({
      customer_id: "1",
      product_key: "field_fence",
    });
    // 这是"默认可覆盖"的偏好：失败不弹通用报错（silent），失败由行卡回落默认名
    expect(config.silent).toBe(true);
    view.cleanup();
  });

  it("无历史 → product_name=null 也是成功响应（前端回落默认名）", async () => {
    const get = vi.mocked(apiClient.get);
    get.mockResolvedValue({ data: { product_name: null } } as never);

    const view = renderHook(() => useProductNamePreference("1", "field_fence"));
    await view.settle();

    expect(view.hook().data).toEqual({ product_name: null });
    view.cleanup();
  });

  it("缺 customer 或 product → 不发请求", async () => {
    const get = vi.mocked(apiClient.get);

    const noCustomer = renderHook(() =>
      useProductNamePreference(null, "field_fence"),
    );
    await noCustomer.settle();
    expect(get).not.toHaveBeenCalled();
    noCustomer.cleanup();

    const noProduct = renderHook(() => useProductNamePreference("1", null));
    await noProduct.settle();
    expect(get).not.toHaveBeenCalled();
    noProduct.cleanup();
  });
});
