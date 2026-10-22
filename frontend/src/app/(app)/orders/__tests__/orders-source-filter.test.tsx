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
  /** A1（P0-A）：列表行带待批明细变更数（本单 2 条 ⇒ 显示角标） */
  pending_item_change_count: 2,
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
  pending_item_change_count: 0,
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

/** 深链目标单（不在列表第 1 页里）：详情面板按 id 单独 GET /orders/42。 */
const DEEP_LINK_ORDER = {
  ...INQUIRY_ORDER,
  id: 42,
  order_no: "ORD-202610-0042",
  amount_breakdown: {
    goods_amount: 1000,
    freight_amount: 0,
    insurance_amount: 0,
    other_amount: 0,
  },
  items: [
    {
      id: 1,
      product_name: "勾花网",
      spec_snapshot: { specification: "2.5mm" },
      qty: 10,
      qty_unit: "ROLLS",
      unit_price: 100,
      line_amount: 1000,
      currency: "USD",
    },
  ],
};

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
    if (path === "/orders/42") return ok(DEEP_LINK_ORDER);
    if (path === "/orders/42/item-change-requests") {
      return ok({ items: [], total: 0 });
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
  // 深链用例会改 location.search，复位避免影响后续用例
  window.history.replaceState(null, "", "/");
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
describe("待批角标（A1 / P0-A）", () => {
  it("pending_item_change_count > 0 显示「有变更待批」，aria-label 含条数；0 不显示", async () => {
    await mount();
    // 宽屏表与窄屏卡（CSS 隐藏其一）都会渲染角标 ⇒ 按容器分别断言
    const badges = Array.from(
      container!.querySelectorAll('tbody [aria-label^="有变更待批"]'),
    );
    expect(badges).toHaveLength(1);
    expect(badges[0]?.getAttribute("aria-label")).toBe("有变更待批 2 条");
    expect(badges[0]?.textContent).toContain("有变更待批");

    // 角标挂在有 2 条申请的订单行上；另一单（0 条）不显示
    const rows = Array.from(container!.querySelectorAll("tbody tr"));
    const withBadge = rows.find((row) =>
      row.textContent?.includes("ORD-202610-0001"),
    );
    const withoutBadge = rows.find((row) =>
      row.textContent?.includes("ORD-202610-0002"),
    );
    expect(withBadge?.textContent).toContain("有变更待批");
    expect(withoutBadge?.textContent).not.toContain("有变更待批");
  });

  it("窄屏卡片同样显示角标（移动端不丢待批信号）", async () => {
    await mount();
    const mobile = container!.querySelector(".md\\:hidden");
    expect(mobile).not.toBeNull();
    expect(
      mobile!.querySelector('[aria-label="有变更待批 2 条"]'),
    ).not.toBeNull();
  });
});

describe("通知深链 /orders?id=（通知链 A4）", () => {
  it("按 ?id= 打开详情：拉 GET /orders/42 并显示订单详情", async () => {
    window.history.replaceState(null, "", "/orders?id=42");
    await mount();
    // 详情单独拉取（不依赖当前页列表里有没有这条）
    expect(
      vi
        .mocked(apiClient.get)
        .mock.calls.some(([url]) => String(url) === "/orders/42"),
    ).toBe(true);
    expect(container!.textContent).toContain("订单详情 · ORD-202610-0042");
  });

  it("关闭详情时清掉 URL 上的 ?id=，刷新不会再把详情弹回来", async () => {
    window.history.replaceState(null, "", "/orders?id=42");
    await mount();
    const close = Array.from(container!.querySelectorAll("button")).find(
      (el) => (el.textContent ?? "").trim() === "关闭",
    );
    act(() => {
      close!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(window.location.search).not.toContain("id=");
  });

  it("无 ?id= 时不自动打开详情", async () => {
    await mount();
    expect(container!.textContent).not.toContain("订单详情 ·");
  });
});
