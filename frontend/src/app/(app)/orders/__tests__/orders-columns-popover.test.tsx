/**
 * 订单列表 · 列配置浮层（O5，U-P1 小项）。
 *
 * 原生 <details> 不会"点别处自动收起"：浮层会一直盖在表格上，且 Esc 也关不掉。
 * O5 起改用共享 `PopoverPanel`（一个模式一个正规实现）。本测试钉住：
 *  1. trigger 的 aria-expanded 随开合变化，面板是 role="dialog"；
 *  2. Esc 收起浮层，并把焦点还给 trigger（否则焦点落在已隐藏的复选项上）；
 *  3. 点浮层外面收起；
 *  4. 点浮层里面**不**收起（阳性对照，防"一律关闭"的假修复）；
 *  5. 原有列配置功能保留：取消勾选后该列从表头消失。
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

/** 列配置 trigger（PopoverPanel 的按钮） */
function columnsTrigger(): HTMLButtonElement {
  const el = Array.from(container!.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === "列配置",
  );
  if (!el) throw new Error("没找到列配置 trigger");
  return el as HTMLButtonElement;
}

function columnsPanel(): HTMLElement | null {
  return container!.querySelector('[data-slot="popover-panel"]');
}

async function openPanel() {
  act(() => {
    columnsTrigger().click();
  });
  await settle(1);
}

function headerLabels(): string[] {
  return Array.from(container!.querySelectorAll("thead th")).map((th) =>
    (th.textContent ?? "").trim(),
  );
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

describe("订单列表 · 列配置浮层（O5 · PopoverPanel）", () => {
  it("点击 trigger 展开：aria-expanded + role=dialog + 9 列复选项", async () => {
    await mount();
    expect(columnsTrigger().getAttribute("aria-expanded")).toBe("false");

    await openPanel();
    expect(columnsTrigger().getAttribute("aria-expanded")).toBe("true");
    expect(columnsPanel()?.getAttribute("role")).toBe("dialog");
    expect(columnsPanel()?.getAttribute("aria-label")).toBe("列配置");
    expect(
      columnsPanel()!.querySelectorAll('input[type="checkbox"]').length,
    ).toBe(9);
  });

  it("Esc 收起浮层，焦点回到 trigger", async () => {
    await mount();
    await openPanel();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle(1);

    expect(columnsPanel()).toBeNull();
    expect(columnsTrigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(columnsTrigger());
  });

  it("点浮层外面收起", async () => {
    await mount();
    await openPanel();

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    await settle(1);

    expect(columnsPanel()).toBeNull();
  });

  it("点浮层里面不收起（阳性对照）", async () => {
    await mount();
    await openPanel();

    const checkbox = columnsPanel()!.querySelector("input")!;
    act(() => {
      checkbox.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(columnsPanel()).not.toBeNull();
  });

  it("列配置功能保留：取消勾选「订单号」后该列从表头消失", async () => {
    await mount();
    expect(headerLabels()).toContain("订单号");

    await openPanel();
    const label = Array.from(
      columnsPanel()!.querySelectorAll("label"),
    ).find((el) => (el.textContent ?? "").includes("订单号"));
    const checkbox = label?.querySelector("input");
    expect(checkbox).not.toBeUndefined();

    act(() => {
      checkbox!.click();
    });
    await settle(1);

    expect(headerLabels()).not.toContain("订单号");
    // 其它列还在（不是整表清空）
    expect(headerLabels()).toContain("客户");
  });
});
