/**
 * U-P0B3（审计 §4）：定价数据「加载中 / 失败 / 空态」三态分离。
 *
 * 钉死：
 *  1. 产品列表失败 ⇒ ErrorState（不是「还没有可用的产品」）；
 *  2. 定价矩阵失败 ⇒ ErrorState + 后端原因 + 重试（不是「该产品未声明定价键」）；
 *  3. 加载中 ⇒ LoadingBlock（不再是「加载产品…」纯文本）。
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

import { PricingDataManager } from "../pricing-data-manager";

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

const PRODUCT = { key: "field_fence", name: "牛栏网" };
const MATRIX = {
  product_key: "field_fence",
  product_name: "牛栏网",
  cost_unit: "CNY/kg",
  dims: [{ field: "wire", label: "边丝径", unit: "mm" }],
  rows: [
    {
      key: "2.0",
      values: { wire: "2.0" },
      labels: ["2.0"],
      amount: 4.5,
      unit: "kg",
      configured: true,
      item_id: 1,
      effective_from: "2026-10-01T00:00:00Z",
    },
  ],
  customers: [],
};

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
        <PricingDataManager />
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
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("定价数据三态", () => {
  it("产品列表失败 ⇒ ErrorState（不是「还没有可用的产品」）", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      if (String(url) === "/auth/me") return ok({ account_type: "internal" });
      if (String(url) === "/export-quote/products") {
        throw backendError("产品服务不可用");
      }
      return ok({});
    });

    await mount();

    expect(alertText()).toContain("产品列表读取失败");
    expect(alertText()).toContain("产品服务不可用");
    expect(container!.textContent).not.toContain("还没有可用的产品");
  });

  it("定价矩阵失败 ⇒ ErrorState + 重试（不是「未声明定价键」）", async () => {
    let matrixCalls = 0;
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/auth/me") return ok({ account_type: "internal" });
      if (path === "/export-quote/products") {
        return ok({ products: [PRODUCT], total: 1 });
      }
      if (path === "/pricing-data") {
        matrixCalls += 1;
        if (matrixCalls === 1) throw backendError("定价服务不可用");
        return ok(MATRIX);
      }
      return ok({});
    });

    await mount();

    expect(alertText()).toContain("定价数据读取失败");
    expect(alertText()).toContain("定价服务不可用");
    expect(container!.textContent).not.toContain("未声明「定价键」");

    const retry = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "重试",
    );
    expect(retry).toBeTruthy();
    await act(async () => {
      retry!.click();
    });
    await settle();

    expect(matrixCalls).toBe(2);
    expect(alertText()).toBeNull();
    expect(container!.textContent).toContain("成本价（定价数据）");
    expect(container!.textContent).toContain("2.0");
  });

  it("加载中 ⇒ LoadingBlock（不是「加载产品…」文字）", async () => {
    vi.mocked(apiClient.get).mockImplementation(
      () => new Promise<GetResp>(() => {}) as never,
    );

    await mount();

    expect(
      document.querySelector('[aria-busy="true"][aria-label="加载中"]'),
    ).not.toBeNull();
    expect(container!.textContent).not.toContain("加载产品…");
    expect(alertText()).toBeNull();
  });
});
