/**
 * /orders 工位来源改造（设计 §9.2）：
 *   · 列表「来源」列：询盘转化 / 直接下单 · 渠道；
 *   · 列表「关联询盘/报价」列：/inquiries?inquiry_id=、/quotes?tab=records 可点跳；
 *   · 来源/渠道筛选真的进请求参数（GET /orders?source_type=&source_channel=）；
 *   · 两种新建入口（报价转订单 / 直接新建订单）平级可见。
 *
 * 页面测试范式同 orders-pagination.test.tsx：createRoot + act + mock @/lib/api/client
 * （本仓库不用 @testing-library/react）。
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
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import OrdersPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

const INQUIRY_ORDER = {
  id: 1,
  order_no: "ORD-202610-0001",
  customer_name: "联佳丝网",
  status: "confirmed",
  currency: "USD",
  total_amount: 1000,
  order_date: "2026-10-01",
  delivery_date: null,
  incoterm: "FOB",
  payment_terms: "30% T/T",
  port_of_loading: null,
  port_of_destination: "HAMBURG",
  shipping_marks: null,
  country_of_origin: "CN",
  source_type: "inquiry",
  source_channel: "alibaba",
  inquiry_id: 7,
  quote_id: 9,
  confirmed_at: "2026-10-20T00:00:00Z",
  confirmed_by: 3,
  confirmed_source: "manual",
  created_at: "2026-10-01T00:00:00Z",
};

const DIRECT_ORDER = {
  ...INQUIRY_ORDER,
  id: 2,
  order_no: "ORD-202610-0002",
  status: "pending",
  source_type: "direct",
  source_channel: "phone",
  inquiry_id: null,
  quote_id: null,
  confirmed_at: null,
  confirmed_by: null,
  confirmed_source: null,
};

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

function orderCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url) === "/orders");
}

function lastOrderParams() {
  const calls = orderCalls();
  return (
    calls[calls.length - 1]?.[1] as
      | { params?: Record<string, unknown> }
      | undefined
  )?.params;
}

function setSelect(ariaLabel: string, value: string) {
  const select = container!.querySelector<HTMLSelectElement>(
    `select[aria-label="${ariaLabel}"]`,
  );
  if (!select) throw new Error(`没找到 select: ${ariaLabel}`);
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
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

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/orders") {
      return ok({
        items: [INQUIRY_ORDER, DIRECT_ORDER],
        total: 2,
        page: 1,
        page_size: 20,
      });
    }
    if (path === "/quotes")
      return ok({ items: [], total: 0, page: 1, page_size: 100 });
    return ok({ items: [], total: 0, page: 1, page_size: 20 });
  });
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

describe("订单列表 · 来源列", () => {
  it("询盘转化的订单显示来源徽标，并给出询盘/报价深链", async () => {
    await mount();
    const text = container!.textContent ?? "";
    expect(text).toContain("询盘转化");
    expect(text).toContain("直接下单 · 电话");

    const links = Array.from(container!.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toContain("/inquiries?inquiry_id=7");
    expect(links).toContain("/quotes?tab=records");
    expect(text).toContain("询盘 #7");
    expect(text).toContain("报价单 #9");
  });

  it("直接下单没有询盘/报价时显示「—」，不造死链", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      if (String(url) === "/orders") {
        return ok({ items: [DIRECT_ORDER], total: 1, page: 1, page_size: 20 });
      }
      return ok({ items: [], total: 0, page: 1, page_size: 20 });
    });
    await mount();
    const rows = Array.from(container!.querySelectorAll("tbody tr"));
    const directRow = rows.find((row) =>
      (row.textContent ?? "").includes("ORD-202610-0002"),
    );
    expect(directRow?.textContent).toContain("—");
    const links = Array.from(container!.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(links).not.toContain("/quotes?tab=records");
  });
});

describe("订单列表 · 来源/渠道筛选", () => {
  it("默认不带来源参数", async () => {
    await mount();
    expect(lastOrderParams()).toEqual({ page: 1, page_size: 20 });
  });

  it("选来源 inquiry ⇒ source_type=inquiry 且回到第 1 页", async () => {
    await mount();
    setSelect("来源筛选", "inquiry");
    await settle();
    expect(lastOrderParams()).toMatchObject({
      page: 1,
      source_type: "inquiry",
    });
  });

  it("选渠道 phone ⇒ source_channel=phone（渠道清单与询盘枚举同源）", async () => {
    await mount();
    setSelect("渠道筛选", "phone");
    await settle();
    expect(lastOrderParams()).toMatchObject({
      page: 1,
      source_channel: "phone",
    });
    const text = container!.textContent ?? "";
    expect(text).toContain("电话");
  });

  it("清除来源筛选把两个参数一起撤掉", async () => {
    await mount();
    setSelect("来源筛选", "direct");
    await settle();
    setSelect("渠道筛选", "phone");
    await settle();
    const clear = Array.from(container!.querySelectorAll("button")).find((el) =>
      (el.textContent ?? "").includes("清除来源筛选"),
    );
    act(() => {
      clear!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(lastOrderParams()).toEqual({ page: 1, page_size: 20 });
  });
});

describe("新建订单入口平级", () => {
  it("报价转订单与直接新建订单两个入口都在首屏且文案对等", async () => {
    await mount();
    const text = container!.textContent ?? "";
    expect(text).toContain("新建订单 · 方式一：由报价单转订单");
    expect(text).toContain("新建订单 · 方式二：直接新建订单（五步向导）");
    // 向导第 1 步的来源字段与渠道选择可见（直接新建不再隐藏）
    expect(
      container!.querySelector('input[name="order-source"]'),
    ).not.toBeNull();
  });
});
