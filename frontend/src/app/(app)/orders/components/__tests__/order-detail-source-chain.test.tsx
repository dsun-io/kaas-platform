/**
 * 订单详情 · 来源链 + 变更待批横幅（设计 §9.2 / §6.1）。
 *
 * 钉死三件事：
 *  1. 询盘转化单展示「询盘 → 报价 → 本订单」可点跳；直接下单展示渠道与确认痕迹；
 *  2. 有 pending 变更申请时顶部横幅出现，新旧对比按事实显示（数量 10 → 12）；
 *  3. 批准/拒绝真的打到 item-change-requests 端点；拒绝缺理由被前端拦住（不白打请求）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, post: mocks.post, patch: mocks.patch },
  apiClient: { get: mocks.get, post: mocks.post, patch: mocks.patch },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { OrderDetailPanel } from "../order-detail-panel";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    order_no: "ORD-202610-0009",
    customer_name: "联佳丝网",
    status: "confirmed",
    currency: "USD",
    total_amount: 1000,
    order_date: "2026-10-01",
    delivery_date: "2026-11-01",
    incoterm: "FOB Tianjin",
    payment_terms: "T/T 30%",
    port_of_loading: "Tianjin",
    port_of_destination: "Hamburg",
    shipping_marks: "N/M",
    country_of_origin: "China",
    notes: null,
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
    source_type: "inquiry",
    source_channel: "alibaba",
    inquiry_id: 7,
    quote_id: 9,
    confirmed_at: "2026-10-20T10:00:00Z",
    confirmed_by: 3,
    confirmed_source: "manual",
    ...overrides,
  };
}

const PENDING = {
  id: 2,
  order_id: 9,
  order_no: "ORD-202610-0009",
  requested_by: 3,
  reason: "客户追加 2 卷",
  items: [
    {
      product_name: "勾花网",
      spec_snapshot: { specification: "2.5mm" },
      qty: 12,
      qty_unit: "ROLLS",
      unit_price: 100,
      line_amount: 1200,
      currency: "USD",
    },
  ],
  snapshot: [
    {
      product_name: "勾花网",
      spec_snapshot: { specification: "2.5mm" },
      qty: 10,
      qty_unit: "ROLLS",
      unit_price: 100,
      line_amount: 1000,
      currency: "USD",
    },
  ],
  status: "pending",
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  team_id: 1,
  created_at: "2026-10-22T09:00:00Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;
let order: Record<string, unknown> = baseOrder();
let pendingRequests: Record<string, unknown>[] = [];

async function settle(times = 5) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <OrderDetailPanel orderId={9} onClose={() => {}} />
    </QueryClientProvider>
  );
  act(() => root!.render(tree));
}

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").trim().includes(text),
  ) as HTMLButtonElement | undefined;
}

function click(text: string) {
  const el = button(text);
  if (!el) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** 点弹窗里的按钮（横幅按钮与确认弹窗同文案，必须限定在 dialog 内）。 */
function clickInDialog(text: string) {
  const dialog = document.querySelector('[role="dialog"]');
  const el = Array.from(dialog?.querySelectorAll("button") ?? []).find((b) =>
    (b.textContent ?? "").trim().includes(text),
  );
  if (!el) throw new Error(`弹窗里没找到按钮「${text}」`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setTextarea(label: string, value: string) {
  const el = document.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`没找到输入框「${label}」`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  order = baseOrder();
  pendingRequests = [];
  mocks.get.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/orders/9") return { data: order };
    if (path === "/orders/9/item-change-requests") {
      return {
        data: { items: pendingRequests, total: pendingRequests.length },
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  mocks.post.mockResolvedValue({
    data: {
      ...PENDING,
      status: "approved",
      applied: true,
      affected_docs: [{ doc_type: "pi", doc_no: "PI-1", status: "issued" }],
      new_total_amount: 1200,
    },
  });
  mocks.patch.mockResolvedValue({ data: order });
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

describe("来源链横幅", () => {
  it("询盘转化：询盘/报价深链 + 确认痕迹", async () => {
    pendingRequests = [];
    mount();
    await settle();
    // 来源链容器是 aria-label（不是正文），用属性选，避免依赖文案排版
    expect(document.querySelector('[aria-label="订单来源链"]')).not.toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).toContain("询盘转化");
    const links = Array.from(document.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toContain("/inquiries?inquiry_id=7");
    expect(links).toContain("/quotes?tab=records");
    expect(text).toContain("确认痕迹：2026-10-20");
    expect(text).toContain("人工确认");
    expect(text).toContain("操作人 #3");
  });

  it("直接下单：正常分类 + 渠道 + 未确认提示", async () => {
    order = baseOrder({
      source_type: "direct",
      source_channel: "phone",
      inquiry_id: null,
      quote_id: null,
      confirmed_at: null,
      confirmed_by: null,
      confirmed_source: null,
    });
    pendingRequests = [];
    mount();
    await settle();
    const text = document.body.textContent ?? "";
    expect(text).toContain("直接下单 · 电话");
    expect(text).toContain("直接下单（正常分类）");
    expect(text).toContain("尚未确认");
  });
});

describe("变更待批横幅", () => {
  it("pending 申请：显示新旧对比与原因，批准走 approve 端点", async () => {
    pendingRequests = [PENDING];
    mount();
    await settle();
    const text = document.body.textContent ?? "";
    expect(text).toContain("有变更待批");
    expect(text).toContain("客户追加 2 卷");
    expect(text).toContain("修改");
    expect(text).toContain("数量：10 → 12");
    expect(text).toContain("明细变更历史（1）");

    click("批准并应用");
    await settle();
    // 二次确认弹窗里再点一次「批准并应用」
    clickInDialog("批准并应用");
    await settle();
    expect(mocks.post).toHaveBeenCalledWith(
      "/orders/9/item-change-requests/2/approve",
      {},
    );
    const { toast } = await import("sonner");
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("PI-1"),
    );
  });

  it("拒绝缺理由被前端拦住；填了理由才 POST reject", async () => {
    pendingRequests = [PENDING];
    mount();
    await settle();
    click("拒绝");
    await settle();
    click("提交拒绝");
    await settle();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("拒绝必须填写理由");

    setTextarea("拒绝理由", "客户只是询价暂不下单");
    await settle();
    click("提交拒绝");
    await settle();
    expect(mocks.post).toHaveBeenCalledWith(
      "/orders/9/item-change-requests/2/reject",
      { reason: "客户只是询价暂不下单" },
    );
  });

  it("历史里的已处理申请展示状态与审批说明", async () => {
    pendingRequests = [
      {
        ...PENDING,
        id: 1,
        status: "rejected",
        reason: "改价",
        decided_by: 4,
        decided_at: "2026-10-22T10:00:00Z",
        decision_reason: "价格已报客户",
      },
    ];
    mount();
    await settle();
    const text = document.body.textContent ?? "";
    expect(text).toContain("已拒绝");
    expect(text).toContain("审批说明：价格已报客户");
    expect(text).not.toContain("有变更待批");
  });
});
