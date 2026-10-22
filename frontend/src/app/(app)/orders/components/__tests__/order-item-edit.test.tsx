/**
 * 订单货物明细编辑（设计 §9.2 / §6.1）：
 *   · pending：保存 = PATCH /orders/{id} 带整批 items（行金额随数量重算）；
 *   · confirmed：保存 = POST item-change-requests（原因必填，订单不变）；
 *   · 校验在本地先拦（缺原因/空明细不打请求）。
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

function order(status: string) {
  return {
    id: 9,
    order_no: "ORD-202610-0009",
    customer_name: "联佳丝网",
    status,
    currency: "USD",
    total_amount: 1000,
    order_date: "2026-10-01",
    delivery_date: null,
    incoterm: "FOB",
    payment_terms: null,
    port_of_loading: null,
    port_of_destination: null,
    shipping_marks: null,
    country_of_origin: null,
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
    source_type: "direct",
    source_channel: null,
    inquiry_id: null,
    quote_id: null,
    confirmed_at: null,
    confirmed_by: null,
    confirmed_source: null,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;
let currentStatus = "pending";

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

function setInput(label: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`没找到输入框「${label}」`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setTextarea(label: string, value: string) {
  const el = document.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`没找到多行输入「${label}」`);
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
  currentStatus = "pending";
  mocks.get.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/orders/9") return { data: order(currentStatus) };
    if (path === "/orders/9/item-change-requests") {
      return { data: { items: [], total: 0 } };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  mocks.patch.mockResolvedValue({ data: order("pending") });
  mocks.post.mockResolvedValue({ data: { id: 3, status: "pending" } });
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

describe("pending 订单：直接改明细", () => {
  it("改数量后保存 ⇒ PATCH /orders/9 传整批 items，行金额重算", async () => {
    mount();
    await settle();
    click("编辑明细");
    await settle();
    expect(
      document.querySelector('input[aria-label="第 1 行产品"]'),
    ).not.toBeNull();

    setInput("第 1 行数量", "12");
    await settle();
    click("保存货物明细");
    await settle();

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    const [url, body] = mocks.patch.mock.calls[0]!;
    expect(url).toBe("/orders/9");
    const payload = body as { items: Record<string, unknown>[] };
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      product_name: "勾花网",
      qty: 12,
      qty_unit: "ROLLS",
      unit_price: 100,
      currency: "USD",
      line_amount: 1200,
      sort_order: 0,
      spec_snapshot: { specification: "2.5mm" },
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("空产品名在本地拦下（不打 PATCH）", async () => {
    mount();
    await settle();
    click("编辑明细");
    await settle();
    setInput("第 1 行产品", "");
    await settle();
    click("保存货物明细");
    await settle();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("请填产品名称");
  });
});

describe("confirmed 订单：变更申请", () => {
  it("原因必填：不填不发请求；填了 POST item-change-requests", async () => {
    currentStatus = "confirmed";
    mount();
    await settle();
    click("申请变更明细");
    await settle();
    setInput("第 1 行数量", "12");
    await settle();

    click("提交变更申请");
    await settle();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("必须填写变更原因");

    setTextarea("变更原因", "客户追加 2 卷");
    await settle();
    click("提交变更申请");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, body] = mocks.post.mock.calls[0]!;
    expect(url).toBe("/orders/9/item-change-requests");
    const payload = body as {
      items: Record<string, unknown>[];
      reason: string;
    };
    expect(payload.reason).toBe("客户追加 2 卷");
    expect(payload.items[0]).toMatchObject({ qty: 12, line_amount: 1200 });
    // 走审批时不能顺手 PATCH 订单（订单本身不变）
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});
