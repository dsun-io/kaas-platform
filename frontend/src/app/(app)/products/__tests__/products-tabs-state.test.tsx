/**
 * 产品工位合并为**一个页面**（2026-10-18 用户口径）
 *
 * 旧版是两个 tab（图片与基础信息 / 定义），维护一个产品要来回切换；现在
 * 两块的**内容同页同时可见**，旧深链 `?tab=definitions` 仍可进入（自动滚到定义）。
 *
 * 这组用例只守容器行为：不再有 tab 切换、两块都渲染、深链不 404。
 * 真组件的读写契约由 `products-redirect-and-definitions.test.tsx` 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

import ProductsWorkstationPage from "../page";

vi.mock("../tabs/products-media-tab", () => ({
  ProductsMediaTab: () => <div data-testid="stub-media">图片与基础信息</div>,
}));
vi.mock("../tabs/products-definitions-tab", () => ({
  ProductsDefinitionsTab: () => <div data-testid="stub-definitions">定义</div>,
}));

vi.mock("@/lib/api/client", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// React 18 act() 需要这个开关
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

(apiClient.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
  data: { items: [], media_kinds: {} },
});

let container: HTMLDivElement;
let root: Root;

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductsWorkstationPage />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  // scrollIntoView 在 jsdom 里不存在；深链逻辑调用它，补个空实现
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", "/products");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("产品工位 · 单页合并", () => {
  it("图片与基础信息、定义两块同时可见，不再有 tab 切换按钮", () => {
    render();
    expect(container.querySelector('[data-testid="stub-media"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="stub-definitions"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("旧深链 ?tab=definitions 仍可进入，不报错", () => {
    window.history.replaceState(null, "", "/products?tab=definitions");
    render();
    expect(
      container.querySelector('[data-testid="stub-definitions"]'),
    ).not.toBeNull();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
