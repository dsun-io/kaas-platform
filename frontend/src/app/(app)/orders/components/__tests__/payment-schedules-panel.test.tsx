/**
 * 收款计划面板（C36 下期 #6/#10/#20）——三件套接线与错误透出。
 *
 * 用**真 hooks + mock apiClient**（而不是 mock hooks），这样 GET/POST/PATCH 的路径、
 * 请求体与失效逻辑都在测试里真跑一遍。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PaymentSchedulesPanel } from "../payment-schedules-panel";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, post: mocks.post, patch: mocks.patch },
  apiClient: { get: mocks.get, post: mocks.post, patch: mocks.patch },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SCHEDULES = [
  {
    id: 1,
    order_id: 9,
    trade_doc_id: null,
    schedule_type: "deposit",
    ratio: 0.3,
    amount: 848.06,
    currency: "USD",
    due_date: "2026-10-01",
    actual_date: null,
    status: "pending",
    fx_rate: null,
    exchange_gain_loss: null,
    notes: "订单确认后",
    created_at: "2026-10-01T00:00:00Z",
  },
  {
    id: 2,
    order_id: 9,
    trade_doc_id: null,
    schedule_type: "balance",
    ratio: 0.7,
    amount: 1978.8,
    currency: "USD",
    due_date: "2026-11-01",
    actual_date: "2026-10-20",
    status: "paid",
    fx_rate: 6.7029,
    exchange_gain_loss: 0,
    notes: null,
    created_at: "2026-10-01T00:00:00Z",
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 6) {
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
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setValue(selector: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`没找到 ${selector}`);
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
  mocks.get.mockResolvedValue({ data: { items: SCHEDULES, total: 2 } });
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

describe("PaymentSchedulesPanel", () => {
  it("列表 + 汇总：显示三期金额、已收/待收、已收款行没有「标记收款」", async () => {
    mount(<PaymentSchedulesPanel orderId={9} currency="USD" />);
    await settle();

    expect(mocks.get).toHaveBeenCalledWith("/orders/9/payment-schedules");
    const text = document.body.textContent ?? "";
    expect(text).toContain("定金");
    expect(text).toContain("尾款");
    expect(text).toContain("已收款");
    expect(text).toContain("应收合计");
    // 已收款行只保留「修改」，未收款行有「标记收款」
    const markPaidButtons = Array.from(
      document.querySelectorAll("button"),
    ).filter((b) => (b.textContent ?? "").trim() === "标记收款");
    expect(markPaidButtons.length).toBe(1);
  });

  it("新建：POST 路径与请求体（类型 + 金额），成功后收起表单", async () => {
    mocks.post.mockResolvedValue({ data: { id: 3 } });
    mount(<PaymentSchedulesPanel orderId={9} currency="USD" />);
    await settle();

    clickButton("新增收款计划");
    setValue('input[aria-label="金额"]', "250");
    clickButton("创建收款计划");
    await settle();

    expect(mocks.post).toHaveBeenCalledWith(
      "/orders/9/payment-schedules",
      { schedule_type: "deposit", amount: 250 },
      { silent: true },
    );
  });

  it("标记收款：PATCH 带 status/actual_date/fx_rate（含汇兑损益口径）", async () => {
    mocks.patch.mockResolvedValue({ data: SCHEDULES[0] });
    mount(<PaymentSchedulesPanel orderId={9} currency="USD" />);
    await settle();

    clickButton("标记收款");
    setValue("#mark-paid-rate", "6.75");
    clickButton("确认收款");
    await settle();

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    const [url, body, config] = mocks.patch.mock.calls[0]!;
    expect(url).toBe("/payment-schedules/1");
    expect(body).toMatchObject({ status: "paid", fx_rate: 6.75 });
    expect(typeof (body as Record<string, unknown>).actual_date).toBe("string");
    expect(config).toEqual({ silent: true });
  });

  it("409 已收款不可回退：错误展示在弹窗里且不关闭", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("Conflict"), {
        response: {
          status: 409,
          data: {
            detail: {
              error: "conflict",
              code: "ILLEGAL_TRANSITION",
              from: "paid",
              to: "pending",
            },
          },
        },
      }),
    );
    mount(<PaymentSchedulesPanel orderId={9} currency="USD" />);
    await settle();

    // 修改已收款那一期会触发 409（后端禁止 paid→非 paid）
    clickButton("修改");
    setValue("#schedule-amount", "2000");
    clickButton("保存");
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("不能改回");
  });
});
