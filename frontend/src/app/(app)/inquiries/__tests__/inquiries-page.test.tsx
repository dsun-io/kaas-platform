/**
 * 询盘工位页面测试（/inquiries）。
 *
 * 钉死口径：
 *  1. 列表一行要能回答「后来怎样了」：询盘号/客户/产品摘要/渠道/阶段/报价数/订单数/最近报价；
 *  2. 筛选走**内核真实 Query 名**（stage/channel/customer_id/date_from/date_to/q），
 *     且**不发 page/page_size**（内核没有分页参数）；
 *  3. 日期倒置在前端拦截，不发必然 422 的请求；
 *  4. 详情抽屉：报价历史（单号/时间/金额/行项数）+ 关联订单深链 /orders?id= + 阶段时间线；
 *  5. 编辑渠道 ⇒ PATCH 只发 channel；行内关闭 ⇒ PATCH status=closed（状态机）。
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

import InquiriesPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

function inquiryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    customer_id: 1,
    inquiry_no: "INQ-202610-0001",
    lead_id: null,
    channel: "alibaba",
    category_id: null,
    product_name_raw: "牛栏网 2.5mm",
    quantity: 1000,
    quantity_unit: "m",
    application: "牧场围栏",
    items: [
      {
        product_key: "field_fence",
        product_name_raw: "牛栏网 2.5mm",
        spec_text: "2.5mm 热镀锌",
        quantity: 1000,
        quantity_unit: "m",
        application: "牧场围栏",
        notes: null,
      },
    ],
    status: "quoted",
    stage: "quotation",
    stage_updated_at: null,
    created_at: "2026-10-17T02:30:00Z",
    company_name: "联佳丝网",
    quote_count: 1,
    order_count: 2,
    latest_quote_at: "2026-10-18T02:30:00Z",
    ...overrides,
  };
}

const ROWS = [
  inquiryRow(),
  inquiryRow({
    id: 2,
    customer_id: 2,
    inquiry_no: "INQ-202610-0002",
    channel: "expo",
    product_name_raw: "勾花网 1.8m",
    items: [
      {
        product_name_raw: "勾花网 1.8m",
        spec_text: null,
        quantity: 500,
        quantity_unit: "m",
        application: null,
        notes: null,
      },
    ],
    status: "closed",
    stage: "closed",
    company_name: "备选客户 B",
    quote_count: 0,
    order_count: 0,
    latest_quote_at: null,
  }),
];

const DETAIL = {
  ...ROWS[0],
  quotes: [
    {
      id: 11,
      quote_no: "QUO-20261017-001",
      customer_id: 1,
      customer_name: "联佳丝网",
      inquiry_id: 1,
      status: "sent",
      currency: "USD",
      total_amount: 3612.36,
      created_at: "2026-10-17T02:30:00Z",
      item_count: 2,
      order_count: 1,
    },
  ],
  orders: [
    {
      id: 5,
      order_no: "ORD-202610-0005",
      customer_id: 1,
      customer_name: "联佳丝网",
      status: "pending",
      currency: "USD",
      total_amount: 3612.36,
      order_date: "2026-10-19",
      delivery_date: null,
      created_at: "2026-10-19T06:00:00Z",
      quote_id: 11,
      inquiry_id: 1,
    },
  ],
  stage_log: [
    {
      id: 1,
      from_stage: "inquiry",
      to_stage: "quotation",
      source_event: "quote_created",
      actor_id: "1",
      note: null,
      created_at: "2026-10-17T02:30:00Z",
    },
  ],
  counts: { quotes: 1, orders: 1, open_orders: 1 },
};

let listRows: unknown[] = ROWS;
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
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <InquiriesPage />
    </QueryClientProvider>
  );
  act(() => root!.render(tree));
  await settle();
}

function inquiryCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url) === "/inquiries");
}

function lastParams() {
  const calls = inquiryCalls();
  const config = calls[calls.length - 1]?.[1] as
    | { params?: Record<string, string> }
    | undefined;
  return config?.params;
}

function buttonByText(
  text: string,
  scope: ParentNode = container!,
): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll("button")).find(
    (el) => (el.textContent ?? "").trim() === text,
  ) as HTMLButtonElement | undefined;
}

function setSelectValue(
  ariaLabel: string,
  value: string,
  scope: ParentNode = container!,
) {
  const select = scope.querySelector(
    `select[aria-label="${ariaLabel}"]`,
  ) as HTMLSelectElement | null;
  if (!select) throw new Error(`没找到 select: ${ariaLabel}`);
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setInputValue(
  ariaLabel: string,
  value: string,
  scope: ParentNode = container!,
) {
  const input = scope.querySelector(
    `input[aria-label="${ariaLabel}"]`,
  ) as HTMLInputElement | null;
  if (!input) throw new Error(`没找到 input: ${ariaLabel}`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  listRows = ROWS;
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/inquiries") {
      return ok({ items: listRows, total: listRows.length });
    }
    if (path === "/inquiries/1") return ok(DETAIL);
    if (path === "/customers") {
      return ok({
        items: [
          { id: 1, company_name: "联佳丝网" },
          { id: 2, company_name: "备选客户 B" },
        ],
        total: 2,
      });
    }
    return ok({ items: [], total: 0 });
  });
  vi.mocked(apiClient.patch).mockResolvedValue(ok({}) as never);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("询盘列表", () => {
  it("一行显示询盘号/客户/产品摘要/渠道/阶段/报价数/订单数/最近报价", async () => {
    await mount();

    expect(inquiryCalls()).toHaveLength(1);
    // 内核没有分页参数：请求里不能出现 page/page_size
    expect(lastParams()).toEqual({});

    const text = container!.textContent ?? "";
    expect(text).toContain("INQ-202610-0001");
    expect(text).toContain("联佳丝网");
    expect(text).toContain("牛栏网 2.5mm");
    expect(text).toContain("阿里巴巴");
    expect(text).toContain("报价"); // 阶段徽标：quotation → 报价
    expect(text).toContain("2026-10-18 02:30"); // 最近报价时间
    expect(text).toContain("2026-10-17"); // 创建时间
    // 报价数 1 / 关联订单 2（两列都在）
    expect(text).toContain("报价数");
    expect(text).toContain("关联订单");
    // 关闭的询盘展示「关闭」阶段
    expect(text).toContain("INQ-202610-0002");
  });

  it("深链：为此询盘报价 = /quotes?tab=product&customer_id=&inquiry_id=", async () => {
    await mount();
    const links = Array.from(container!.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toContain("/quotes?tab=product&customer_id=1&inquiry_id=1");
  });
});

describe("筛选", () => {
  it("点查询后按内核 Query 名请求（stage/q），不带分页参数", async () => {
    await mount();
    setSelectValue("阶段筛选", "order");
    setInputValue("关键字", "fence");
    act(() => {
      buttonByText("查询")!.click();
    });
    await settle();

    const calls = inquiryCalls();
    expect(calls).toHaveLength(2);
    expect(lastParams()).toEqual({ stage: "order", q: "fence" });
  });

  it("日期倒置：前端拦截，不发请求", async () => {
    await mount();
    setInputValue("开始日期", "2026-10-20");
    setInputValue("结束日期", "2026-10-10");
    act(() => {
      buttonByText("查询")!.click();
    });
    await settle();

    expect(container!.textContent).toContain("开始日期不能晚于结束日期");
    expect(inquiryCalls()).toHaveLength(1); // 仍只有首次加载那一次
  });

  it("重置后回到无筛选请求", async () => {
    await mount();
    setSelectValue("渠道筛选", "expo");
    act(() => {
      buttonByText("查询")!.click();
    });
    await settle();
    expect(lastParams()).toEqual({ channel: "expo" });

    act(() => {
      buttonByText("重置")!.click();
    });
    await settle();
    expect(lastParams()).toEqual({});
  });
});

describe("客户端分页", () => {
  it("45 条：翻页只切片、不再请求 /inquiries（内核不分页）", async () => {
    listRows = Array.from({ length: 45 }, (_, i) =>
      inquiryRow({
        id: i + 1,
        inquiry_no: `INQ-202610-${String(i + 1).padStart(4, "0")}`,
      }),
    );
    await mount();

    expect(container!.textContent).toContain("第 1–20 条 / 共 45 条");
    act(() => {
      buttonByText("下一页")!.click();
    });
    await settle();

    expect(container!.textContent).toContain("第 21–40 条 / 共 45 条");
    expect(inquiryCalls()).toHaveLength(1); // 客户端切片，不产生分页请求
  });
});

describe("详情抽屉", () => {
  async function openDetail() {
    const detailButtons = Array.from(
      container!.querySelectorAll("button"),
    ).filter((el) => (el.textContent ?? "").trim() === "详情");
    act(() => {
      (detailButtons[0] as HTMLButtonElement).click();
    });
    await settle();
  }

  it("报价历史（单号/时间/金额/行项数）+ 关联订单深链 + 阶段时间线", async () => {
    await mount();
    await openDetail();

    const body = document.body.textContent ?? "";
    expect(body).toContain("报价历史（1）");
    expect(body).toContain("QUO-20261017-001");
    expect(body).toContain("USD 3,612.36");
    expect(body).toContain("行项数");
    expect(body).toContain("已发送");

    // 关联订单：可点跳 /orders?id=
    const orderLink = Array.from(document.body.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/orders?id=5",
    );
    expect(orderLink).toBeTruthy();
    expect(body).toContain("ORD-202610-0005");

    // 阶段时间线
    expect(body).toContain("询盘 → 报价");
    expect(body).toContain("创建报价单");
  });

  it("编辑渠道 ⇒ PATCH 只发 channel", async () => {
    await mount();
    await openDetail();

    setSelectValue("编辑渠道", "expo", document.body);
    await settle(1);
    const save = buttonByText("保存修改", document.body);
    expect(save).toBeTruthy();
    act(() => {
      save!.click();
    });
    await settle();

    expect(vi.mocked(apiClient.patch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient.patch).mock.calls[0]?.[0]).toBe("/inquiries/1");
    expect(vi.mocked(apiClient.patch).mock.calls[0]?.[1]).toEqual({
      channel: "expo",
    });
  });

  it("改产品行数量 ⇒ PATCH items（第一行同步交后端）", async () => {
    await mount();
    await openDetail();

    setInputValue("第 1 行数量", "1200", document.body);
    await settle(1);
    act(() => {
      buttonByText("保存修改", document.body)!.click();
    });
    await settle();

    const payload = vi.mocked(apiClient.patch).mock.calls[0]?.[1] as {
      items?: Array<Record<string, unknown>>;
      channel?: unknown;
    };
    expect(payload.channel).toBeUndefined();
    expect(payload.items).toHaveLength(1);
    expect(payload.items?.[0]?.quantity).toBe(1200);
  });
});

describe("关闭 / 重开（状态机）", () => {
  it("行内关闭：二次确认后 PATCH status=closed", async () => {
    await mount();
    const closeButton = Array.from(container!.querySelectorAll("button")).find(
      (el) => (el.textContent ?? "").trim() === "关闭",
    );
    act(() => {
      (closeButton as HTMLButtonElement).click();
    });
    await settle();

    expect(document.body.textContent).toContain("关闭询盘？");
    const confirm = buttonByText("关闭询盘", document.body);
    act(() => {
      confirm!.click();
    });
    await settle();

    expect(vi.mocked(apiClient.patch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient.patch).mock.calls[0]?.[0]).toBe("/inquiries/1");
    expect(vi.mocked(apiClient.patch).mock.calls[0]?.[1]).toEqual({
      status: "closed",
    });
  });
});
