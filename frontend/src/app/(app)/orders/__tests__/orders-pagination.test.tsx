import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import OrdersPage from "../page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;
const PAGE_SIZE = 20;
const TOTAL = 45;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function orderRow(n: number) {
  return {
    id: n,
    order_no: `ORD-202610-${String(n).padStart(4, "0")}`,
    customer_name: "联佳丝网",
    status: "pending",
    currency: "USD",
    total_amount: 12300,
    order_date: "2026-10-01",
    delivery_date: null,
    incoterm: "FOB",
    payment_terms: "30% T/T",
    port_of_loading: "NINGBO",
    port_of_destination: "HAMBURG",
    shipping_marks: null,
    country_of_origin: "CN",
    created_at: "2026-10-01T00:00:00Z",
  };
}

function pageOf(page: number) {
  const start = (page - 1) * PAGE_SIZE;
  const count = Math.max(0, Math.min(PAGE_SIZE, TOTAL - start));
  return {
    items: Array.from({ length: count }, (_, i) => orderRow(start + i + 1)),
    total: TOTAL,
    page,
    page_size: PAGE_SIZE,
  };
}

function orderCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url) === "/orders");
}

function lastPageParam() {
  const calls = orderCalls();
  const config = calls[calls.length - 1]?.[1] as
    | { params?: { page?: number; page_size?: number } }
    | undefined;
  return config?.params;
}

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <OrdersPage />
    </QueryClientProvider>
  );
  act(() => root!.render(tree));
  await settle();
}

function button(label: string) {
  return Array.from(container!.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes(label),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(apiClient.get).mockImplementation(async (url: string, config) => {
    const path = String(url);
    if (path === "/orders") {
      const page = Number(
        (config as { params?: { page?: number } } | undefined)?.params?.page ?? 1,
      );
      return ok(pageOf(page));
    }
    if (path === "/quotes") {
      return ok({ items: [], total: 0, page: 1, page_size: 100 });
    }
    return ok({ items: [], total: 0, page: 1, page_size: PAGE_SIZE });
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("订单列表分页（C25）", () => {
  it("第 1 页请求 page=1&page_size=20，并显示总数与当前范围", async () => {
    await mount();

    expect(orderCalls()).toHaveLength(1);
    expect(lastPageParam()).toMatchObject({ page: 1, page_size: PAGE_SIZE });
    expect(container!.textContent).toContain("第 1–20 条 / 共 45 条");
    expect(container!.textContent).toContain("第 1 / 3 页");
    // 第 1 页 20 条（分页条 + 表格都在），不是一次性把 100 条全拉下来
    expect(container!.textContent).toContain("ORD-202610-0001");
  });

  it("点「下一页」按 page=2 重新请求并显示第 21–40 条", async () => {
    await mount();
    await act(async () => {
      button("下一页")!.click();
    });
    await settle();

    expect(orderCalls()).toHaveLength(2);
    expect(lastPageParam()).toMatchObject({ page: 2, page_size: PAGE_SIZE });
    expect(container!.textContent).toContain("第 21–40 条 / 共 45 条");
    expect(container!.textContent).toContain("第 2 / 3 页");
  });

  it("末页范围按实际条数显示（45 条 ⇒ 第 41–45 条）", async () => {
    await mount();
    await act(async () => {
      button("下一页")!.click();
    });
    await settle();
    await act(async () => {
      button("下一页")!.click();
    });
    await settle();

    expect(lastPageParam()).toMatchObject({ page: 3 });
    expect(container!.textContent).toContain("第 41–45 条 / 共 45 条");
    expect(button("下一页")?.disabled).toBe(true);
  });
});
