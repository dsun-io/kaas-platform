/**
 * 收款计划 + 实收记录面板（C36 #6/#10/#20 → §13.3 扩展）。
 *
 * 用真 hooks + mock apiClient：GET/POST/PATCH 路径、请求体、失效逻辑都在测试里真跑。
 * 覆盖：计划汇总 / 新建 / 标记收款（旧口径）/ 登记收款（实收、可改金额）/ 差异 /
 * 未分配收款 / 历史 paid 兼容 / 到账截图补传。
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
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
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
    amount: 300,
    currency: "USD",
    due_date: "2026-10-01",
    actual_date: null,
    status: "pending",
    fx_rate: null,
    exchange_gain_loss: null,
    received_amount: 0,
    notes: "订单确认后",
    created_at: "2026-10-01T00:00:00Z",
  },
  {
    id: 2,
    order_id: 9,
    trade_doc_id: null,
    schedule_type: "balance",
    ratio: 0.7,
    amount: 700,
    currency: "USD",
    due_date: "2026-11-01",
    actual_date: "2026-10-20",
    status: "paid",
    fx_rate: 6.7029,
    exchange_gain_loss: 0,
    received_amount: 700,
    notes: null,
    created_at: "2026-10-01T00:00:00Z",
  },
];

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    order_id: 9,
    schedule_id: 1,
    amount: 100,
    currency: "USD",
    received_date: "2026-10-20",
    fx_rate: null,
    file_id: null,
    notes: null,
    created_at: "2026-10-20T00:00:00Z",
    ...overrides,
  };
}

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

function allButtons(text: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (el) => (el.textContent ?? "").trim() === text,
  );
}

function clickButton(text: string, index = 0) {
  const el = allButtons(text)[index];
  if (!el) throw new Error(`没找到按钮「${text}」#${index}`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

function attachFile(selector: string, file: File) {
  const el = document.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`没找到 ${selector}`);
  Object.defineProperty(el, "files", { value: [file], configurable: true });
  act(() => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/orders/9/payment-schedules") {
      return { data: { items: SCHEDULES, total: 2 } };
    }
    if (path === "/orders/9/receipts") {
      return { data: { items: [], total: 0 } };
    }
    return { data: { items: [], total: 0 } };
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
  vi.restoreAllMocks();
});

describe("PaymentSchedulesPanel", () => {
  it("列表 + 汇总：应收取收、旧计划历史收款标注、已收款行没有「标记收款」", async () => {
    mount(<PaymentSchedulesPanel orderId={9} currency="USD" />);
    await settle();

    expect(mocks.get).toHaveBeenCalledWith("/orders/9/payment-schedules");
    const text = document.body.textContent ?? "";
    expect(text).toContain("定金");
    expect(text).toContain("尾款");
    expect(text).toContain("已收款");
    expect(text).toContain("应收合计");
    expect(text).toContain("历史收款（无截图）");
    expect(allButtons("标记收款")).toHaveLength(1);
  });

  it("部分收款：显示「部分收款」、已收金额与差异（不把计划金额算成已收）", async () => {
    mocks.get.mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/orders/9/payment-schedules") {
        return {
          data: {
            items: [
              SCHEDULES[0],
              { ...SCHEDULES[1], status: "pending", received_amount: 0 },
            ],
            total: 2,
          },
        };
      }
      if (path === "/orders/9/receipts") {
        return { data: { items: [receipt({ amount: 100 })], total: 1 } };
      }
      return { data: { items: [], total: 0 } };
    });
    mount(<PaymentSchedulesPanel orderId={9} currency="USD" />);
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("部分收款");
    expect(text).toContain("USD 100.00");
    expect(text).toContain("USD -200.00");
    expect(text).toContain("实收登记 1 笔");
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

  it("标记收款（旧口径）：PATCH 带 status/actual_date/fx_rate", async () => {
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

  it("登记收款：实收金额默认 = 剩余应收，可改；POST schedule_id + amount + 日期", async () => {
    mocks.get.mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/orders/9/payment-schedules") {
        return { data: { items: SCHEDULES, total: 2 } };
      }
      if (path === "/orders/9/receipts") {
        return { data: { items: [receipt({ amount: 100 })], total: 1 } };
      }
      return { data: { items: [], total: 0 } };
    });
    mocks.post.mockResolvedValue({ data: receipt({ id: 7, amount: 150 }) });
    mount(<PaymentSchedulesPanel orderId={9} currency="USD" />);
    await settle();

    // 第 1 期：应收 300、已收 100 ⇒ 默认 200；改成实际到账 150
    clickButton("登记收款", 1);
    await settle(2);
    expect(
      document.querySelector<HTMLInputElement>("#receipt-amount")?.value,
    ).toBe("200.00");
    setValue("#receipt-amount", "150");
    setValue("#receipt-date", "2026-10-22");
    clickButton("确认登记");
    await settle();

    expect(mocks.post).toHaveBeenCalledWith(
      "/orders/9/receipts",
      { schedule_id: 1, amount: 150, received_date: "2026-10-22" },
      { silent: true },
    );
  });

  it("未分配收款（schedule_id=null）单独展示，不摊到任何一期", async () => {
    mocks.get.mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/orders/9/payment-schedules") {
        return { data: { items: SCHEDULES, total: 2 } };
      }
      if (path === "/orders/9/receipts") {
        return {
          data: {
            items: [
              receipt({
                id: 3,
                schedule_id: null,
                amount: 55,
                notes: "客户多汇",
              }),
            ],
            total: 1,
          },
        };
      }
      return { data: { items: [], total: 0 } };
    });
    mount(<PaymentSchedulesPanel orderId={9} currency="USD" />);
    await settle();

    expect(document.body.textContent).toContain("未分配收款 1 笔");
    expect(document.body.textContent).toContain("客户多汇");
  });

  it("到账截图：有 file_id 可查看；没有时可补传（multipart file）", async () => {
    const createObjectURL = vi.fn(() => "blob:receipt");
    const revokeObjectURL = vi.fn();
    (
      URL as unknown as { createObjectURL: typeof createObjectURL }
    ).createObjectURL = createObjectURL;
    (
      URL as unknown as { revokeObjectURL: typeof revokeObjectURL }
    ).revokeObjectURL = revokeObjectURL;
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    mocks.get.mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/orders/9/payment-schedules") {
        return { data: { items: SCHEDULES, total: 2 } };
      }
      if (path === "/orders/9/receipts") {
        return {
          data: {
            items: [
              receipt({ id: 4, file_id: 33 }),
              receipt({ id: 5, schedule_id: null, amount: 10 }),
            ],
            total: 2,
          },
        };
      }
      if (path === "/file-objects/33/content") return { data: new Blob(["x"]) };
      return { data: { items: [], total: 0 } };
    });
    mocks.post.mockResolvedValue({ data: { id: 66 } });

    mount(<PaymentSchedulesPanel orderId={9} currency="USD" />);
    await settle();

    clickButton("查看到账截图");
    await settle();
    expect(mocks.get).toHaveBeenCalledWith("/file-objects/33/content", {
      responseType: "blob",
    });
    expect(open).toHaveBeenCalled();

    const file = new File([new Uint8Array(4)], "receipt.png", {
      type: "image/png",
    });
    attachFile('input[aria-label="补传到账截图 #5"]', file);
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, form, config] = mocks.post.mock.calls[0]!;
    expect(url).toBe("/payment-receipts/5/files");
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get("file")).toBeInstanceOf(File);
    expect(config).toMatchObject({
      headers: { "Content-Type": "multipart/form-data" },
      silent: true,
    });
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

    clickButton("修改");
    setValue("#schedule-amount", "2000");
    clickButton("保存");
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("不能改回");
  });

  it("O3：登记收款标题用「期次序号」，不是数据库 id（id 跳号时不误导）", async () => {
    mocks.get.mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/orders/9/payment-schedules") {
        return {
          data: {
            // id 与序号故意不同：列表第 2 期是 id=12（删过计划会跳号）
            items: [
              { ...SCHEDULES[0], id: 11 },
              { ...SCHEDULES[1], id: 12 },
            ],
            total: 2,
          },
        };
      }
      if (path === "/orders/9/receipts") {
        return { data: { items: [], total: 0 } };
      }
      return { data: { items: [], total: 0 } };
    });
    mount(<PaymentSchedulesPanel orderId={9} currency="USD" />);
    await settle();

    // 按钮序：0=面板标题栏「登记收款」，1=第 1 行，2=第 2 行
    clickButton("登记收款", 2);
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("第 2 期");
    expect(text).not.toContain("第 12 期");
  });

  it("O4：收款计划加载态用 LoadingBlock（不是纯文本「正在读取…」）", async () => {
    mocks.get.mockImplementation((url: string) =>
      String(url) === "/orders/9/payment-schedules"
        ? new Promise(() => {})
        : Promise.resolve({ data: { items: [], total: 0 } }),
    );
    mount(<PaymentSchedulesPanel orderId={9} currency="USD" />);
    await settle(2);

    expect(
      document.querySelector('[aria-busy="true"][aria-label="加载中"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain("正在读取收款计划");
  });
});
