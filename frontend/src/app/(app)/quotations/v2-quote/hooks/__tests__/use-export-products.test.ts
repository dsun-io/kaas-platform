import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

import { useExportProducts } from "../use-export-quote-import";

vi.mock("@/lib/api/client", () => ({
  default: { get: vi.fn() },
  apiClient: { get: vi.fn() },
}));

/**
 * 报价产品下拉的**停用过滤**守卫（B0-4）。
 *
 * 后端（需求 16）已剔除本团队在报价工位停用的产品，但旧后端 / MSW 种子
 * 可能仍带回 is_active=false / disabled=true 的行 —— 前端在
 * useExportProducts（下拉唯一数据源）里兜底过滤，避免停用的产品
 * 重新出现在报价 / 批量报价 / 产品行的三个下拉里。
 */
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** 用 React 18 自带的 createRoot + act 渲染 hook（仓库没装 testing-library） */
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

function renderProductsHook() {
  return renderHook(() => useExportProducts());
}

function product(key: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    name: key,
    name_en: "",
    category_code: "",
    combo_count: 1,
    spec_summary: "",
    hs_codes: [],
    cost_basis: "",
    cost_unit: "",
    params: {},
    ...extra,
  };
}

describe("useExportProducts · 停用产品过滤（B0-4）", () => {
  let view: ReturnType<typeof renderProductsHook> | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    view?.cleanup();
  });

  it("不带状态标志的产品原样保留，total 与列表一致", async () => {
    const get = vi.mocked(apiClient.get);
    get.mockResolvedValue({
      data: {
        products: [product("chain_link"), product("field_fence")],
        total: 2,
      },
    } as never);

    view = renderProductsHook();
    await view.settle();

    const data = view.hook().data;
    expect(data?.products.map((p) => p.key)).toEqual([
      "chain_link",
      "field_fence",
    ]);
    expect(data?.total).toBe(2);
    expect(String(get.mock.calls[0]![0])).toBe("/export-quote/products");
  });

  it("is_active=false / disabled=true 的行被过滤，total 同步重算", async () => {
    const get = vi.mocked(apiClient.get);
    get.mockResolvedValue({
      data: {
        products: [
          product("chain_link"),
          product("retired_a", { is_active: false }),
          product("retired_b", { disabled: true }),
          product("field_fence", { is_active: true }),
        ],
        total: 4,
      },
    } as never);

    view = renderProductsHook();
    await view.settle();

    const data = view.hook().data;
    expect(data?.products.map((p) => p.key)).toEqual([
      "chain_link",
      "field_fence",
    ]);
    expect(data?.total).toBe(2);
  });
});
