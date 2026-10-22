/**
 * 订单详情面板（§13.3）：金额构成 / 货物明细 / 历史订单回退 / 条款保存。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, patch: mocks.patch },
  apiClient: { get: mocks.get, patch: mocks.patch },
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { OrderDetailPanel } from "../order-detail-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ORDER = {
  id: 9,
  order_no: "ORD-202610-0009",
  customer_name: "联佳丝网",
  status: "confirmed",
  currency: "USD",
  total_amount: 1065,
  order_date: "2026-10-01",
  delivery_date: "2026-11-01",
  incoterm: "FOB Tianjin",
  payment_terms: "T/T 30%",
  port_of_loading: "Tianjin",
  port_of_destination: "Hamburg",
  shipping_marks: "N/M",
  country_of_origin: "China",
  notes: "线下签约",
  amount_breakdown: {
    goods_amount: 1000,
    freight_amount: 50,
    insurance_amount: 10,
    other_amount: 5,
  },
  items: [
    {
      id: 1,
      product_name: "勾花网",
      spec_snapshot: { specification: "2.5mm 热镀锌" },
      qty: 10,
      qty_unit: "ROLLS",
      unit_price: 100,
      line_amount: 1000,
      currency: "USD",
    },
  ],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 5) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>,
    );
  });
}

function clickButton(text: string) {
  const el = Array.from(document.querySelectorAll("button")).find((button) =>
    (button.textContent ?? "").trim() === text,
  );
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: ORDER });
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

describe("OrderDetailPanel", () => {
  it("金额构成 / 货物明细 / 备注完整展示（总额以订单头为准）", async () => {
    mount(<OrderDetailPanel orderId={9} onClose={() => {}} />);
    await settle();

    expect(mocks.get).toHaveBeenCalledWith("/orders/9");
    const text = document.body.textContent ?? "";
    expect(text).toContain("订单详情 · ORD-202610-0009");
    expect(text).toContain("货物金额");
    expect(text).toContain("USD 1,000.00");
    expect(text).toContain("USD 50.00");
    expect(text).toContain("USD 10.00");
    expect(text).toContain("USD 5.00");
    expect(text).toContain("USD 1,065.00");
    expect(text).toContain("勾花网");
    expect(text).toContain("2.5mm 热镀锌");
    expect(text).toContain("单证");
    expect(text).toContain("线下签约");
  });

  it("历史订单没有 amount_breakdown：回退货物行合计 + total_amount 并提示", async () => {
    mocks.get.mockResolvedValue({
      data: {
        ...ORDER,
        amount_breakdown: null,
        total_amount: 1000,
        items: [{ ...ORDER.items[0], line_amount: 1000 }],
      },
    });
    mount(<OrderDetailPanel orderId={9} onClose={() => {}} />);
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("历史订单没有单独记录运费");
    // 运费/保险/其他显示 —，不伪造 0 以外的数字
    expect(text).toContain("USD 1,000.00");
  });

  it("保存贸易条款：PATCH /orders/{id}，只发条款字段；成功后提示", async () => {
    mocks.patch.mockResolvedValue({ data: ORDER });
    mount(<OrderDetailPanel orderId={9} onClose={() => {}} />);
    await settle();

    setInput("目的港", "Brisbane");
    clickButton("保存条款");
    await settle();

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    const [url, body] = mocks.patch.mock.calls[0]!;
    expect(url).toBe("/orders/9");
    expect(body).toMatchObject({
      incoterm: "FOB Tianjin",
      port_of_destination: "Brisbane",
      country_of_origin: "China",
    });
    const { toast } = await import("sonner");
    expect(vi.mocked(toast.success)).toHaveBeenCalled();
  });

  it("详情读取失败：展示错误分支（不是白屏）", async () => {
    mocks.get.mockRejectedValue(new Error("boom"));
    mount(<OrderDetailPanel orderId={9} onClose={() => {}} />);
    await settle();
    expect(document.body.textContent).toContain("订单详情读取失败");
  });
});
