/**
 * 订单列表 · 列配置浮层（O5，U-P1 小项）。
 *
 * 原生 <details> 不会"点别处自动收起"：浮层会一直盖在表格上，且 Esc 也关不掉。
 * 钉住三条：
 *  1. Esc 收起浮层，并把焦点还给 summary（否则焦点落在已隐藏的复选项上）；
 *  2. 点浮层外面收起；
 *  3. 点浮层里面**不**收起（阳性对照，防"一律关闭"的假修复）。
 */
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

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

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
    order_no: "ORD-202610-" + String(n).padStart(4, "0"),
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

function columnsPanel(): HTMLDetailsElement {
  const el = container!.querySelector("details");
  if (!el) throw new Error("没找到列配置 details");
  return el as HTMLDetailsElement;
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/orders") {
      return ok({ items: [orderRow(1)], total: 1, page: 1, page_size: 20 });
    }
    if (path === "/quotes") {
      return ok({ items: [], total: 0, page: 1, page_size: 100 });
    }
    return ok({ items: [], total: 0, page: 1, page_size: 20 });
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client = null;
});

describe("订单列表 · 列配置浮层（O5）", () => {
  it("Esc 收起浮层，焦点回到 summary", async () => {
    await mount();
    const el = columnsPanel();
    act(() => {
      el.open = true;
    });
    expect(el.open).toBe(true);

    const summary = el.querySelector("summary")!;
    act(() => {
      summary.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(el.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("点浮层外面收起", async () => {
    await mount();
    const el = columnsPanel();
    act(() => {
      el.open = true;
    });

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });

    expect(el.open).toBe(false);
  });

  it("点浮层里面不收起（阳性对照）", async () => {
    await mount();
    const el = columnsPanel();
    act(() => {
      el.open = true;
    });

    const checkbox = el.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkbox).not.toBeNull();
    act(() => {
      checkbox!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(el.open).toBe(true);
  });
});
