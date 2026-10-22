/**
 * 手工建单向导（§6 + §13.3）——步骤流转、金额自动、收款计划、POST 请求体、附件。
 *
 * 用**真组件 + mock apiClient**：GET /quotes/{id} 带出报价条款与货物行，
 * 后面每一步的自动计算与最终 payload 都在测试里真跑一遍。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, post: mocks.post },
  apiClient: { get: mocks.get, post: mocks.post },
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { OrderCreateWizard } from "../order-create-wizard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const QUOTE_DETAIL = {
  id: 5,
  quote_no: "QT-202610-0005",
  customer_id: 7,
  customer_name: "联佳丝网",
  status: "sent",
  currency: "EUR",
  total_amount: 1000,
  incoterm: "CIF Hamburg",
  payment_terms: "T/T 30% deposit",
  port_of_loading: "Tianjin",
  port_of_destination: "Hamburg",
  shipping_marks: "N/M",
  country_of_origin: "China",
  items: [
    {
      product_name: "勾花网",
      qty: 10,
      qty_unit: "ROLLS",
      unit_price: 100,
      line_amount: 1000,
      spec_snapshot: { specification: "2.5mm 热镀锌" },
    },
  ],
};

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

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes(text),
  ) as HTMLButtonElement | undefined;
}

function clickButton(text: string) {
  const el = button(text);
  if (!el) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function input(label: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`没找到输入框「${label}」`);
  return el;
}

function setInput(label: string, value: string) {
  const el = input(label);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function selectQuote(value: string) {
  const el = document.querySelector<HTMLSelectElement>(
    'select[aria-label="关联报价单"]',
  );
  if (!el) throw new Error("没找到报价选择器");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/quotes") {
      return {
        data: {
          items: [
            {
              id: 5,
              quote_no: "QT-202610-0005",
              customer_name: "联佳丝网",
              status: "sent",
              currency: "EUR",
              total_amount: 1000,
              incoterm: "CIF Hamburg",
            },
          ],
          total: 1,
        },
      };
    }
    if (path === "/quotes/5") return { data: QUOTE_DETAIL };
    if (path === "/customers") {
      return {
        data: {
          items: [{ id: 7, company_name: "联佳丝网", country: "AU" }],
          total: 1,
        },
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  mocks.post.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/orders") {
      return {
        data: {
          id: 99,
          order_no: "ORD-202610-0099",
          customer_name: "联佳丝网",
          status: "pending",
          currency: "EUR",
          total_amount: 1050,
        },
      };
    }
    if (path === "/orders/99/files") return { data: { id: 12, name: "合同 · c.pdf" } };
    if (path === "/external-docs") return { data: { id: 21, file_name: "po-001.pdf" } };
    throw new Error(`unexpected POST ${path}`);
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

describe("OrderCreateWizard", () => {
  it("选报价自动带出客户/币种/条款/货物行，金额自动汇总并提交完整 payload", async () => {
    const onCreated = vi.fn();
    mount(<OrderCreateWizard onCreated={onCreated} />);
    await settle();

    // 第 1 步：选报价 → 自动选中客户 + 带出条款/货物行
    selectQuote("5");
    await settle();
    expect(document.body.textContent).toContain("联佳丝网");

    clickButton("下一步");
    await settle();
    // 第 2 步：报价条款已带出
    expect(input("币种").value).toBe("EUR");
    expect(input("贸易术语").value).toBe("CIF Hamburg");
    expect(input("目的港").value).toBe("Hamburg");
    expect(input("原产国").value).toBe("China");

    clickButton("下一步");
    await settle();
    // 第 3 步：货物金额 = 10 × 100，总额自动
    expect(document.body.textContent).toContain("EUR 1,000.00");
    setInput("运费", "50");
    await settle();
    expect(document.body.textContent).toContain("EUR 1,050.00");

    clickButton("下一步");
    await settle();
    // 第 4 步：30/70 模板金额按总额自动重算
    expect(input("第 1 期金额").value).toBe("315.00");
    expect(input("第 2 期金额").value).toBe("735.00");

    clickButton("下一步");
    await settle();
    // 第 5 步：跳过附件直接建单
    clickButton("创建订单");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, body] = mocks.post.mock.calls[0]!;
    expect(url).toBe("/orders");
    const payload = body as Record<string, unknown>;
    expect(payload.customer_id).toBe(7);
    expect(payload.customer_name).toBe("联佳丝网");
    expect(payload.quote_order_id).toBe(5);
    expect(payload.currency).toBe("EUR");
    expect(payload.incoterm).toBe("CIF Hamburg");
    expect(payload.amount_breakdown).toEqual({
      goods_amount: 1000,
      freight_amount: 50,
      insurance_amount: 0,
      other_amount: 0,
    });
    expect(payload.payment_plan).toEqual([
      {
        schedule_type: "deposit",
        ratio: 0.3,
        amount: 315,
        notes: "订单确认后",
      },
      {
        schedule_type: "balance",
        ratio: 0.7,
        amount: 735,
        notes: "发货前",
      },
    ]);
    expect(payload.items).toEqual([
      {
        product_name: "勾花网",
        qty: 10,
        qty_unit: "ROLLS",
        unit_price: 100,
        currency: "EUR",
        line_amount: 1000,
        sort_order: 0,
        spec_snapshot: { specification: "2.5mm 热镀锌" },
      },
    ]);
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 99, order_no: "ORD-202610-0099" }),
    );
  });

  it("第 1 步未选客户：本地拦下并给出业务口径提示", async () => {
    mount(<OrderCreateWizard />);
    await settle();
    clickButton("下一步");
    await settle();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("请选择业务客户");
  });

  it("第 5 步附件：先建单再按 multipart 上传，name 带类别前缀", async () => {
    mount(<OrderCreateWizard />);
    await settle();
    selectQuote("5");
    await settle();
    clickButton("下一步"); // 订单信息
    await settle(2);
    clickButton("下一步"); // 货物与金额
    await settle(2);
    clickButton("下一步"); // 收款计划
    await settle(2);
    clickButton("下一步"); // 附件
    await settle();

    const fileInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="选择订单附件"]',
    );
    expect(fileInput).not.toBeNull();
    const file = new File([new Uint8Array(4)], "contract.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(fileInput!, "files", {
      value: [file],
      configurable: true,
    });
    act(() => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(document.body.textContent).toContain("contract.pdf");

    clickButton("创建订单（1 个附件）");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(2);
    const [fileUrl, form, config] = mocks.post.mock.calls[1]!;
    expect(fileUrl).toBe("/orders/99/files");
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get("file")).toBeInstanceOf(File);
    expect((form as FormData).get("name")).toBe("合同 · contract.pdf");
    expect((form as FormData).get("kind")).toBeNull();
    expect(config).toEqual({
      headers: { "Content-Type": "multipart/form-data" },
      silent: true,
    });
  });

  it("第 5 步导入已有单证：先建单，再 POST /external-docs（file/doc_type/order_id/customer_id/notes）", async () => {
    mount(<OrderCreateWizard />);
    await settle();
    selectQuote("5");
    await settle();
    clickButton("下一步"); // 订单信息
    await settle(2);
    clickButton("下一步"); // 货物与金额
    await settle(2);
    clickButton("下一步"); // 收款计划
    await settle(2);
    clickButton("下一步"); // 附件/已有单证
    await settle();

    const fileInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="选择已有单证文件"]',
    )!;
    const file = new File([new Uint8Array(4)], "po-001.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(fileInput, "files", {
      value: [file],
      configurable: true,
    });
    act(() => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(document.body.textContent).toContain("po-001.pdf");

    const typeSelect = document.querySelector<HTMLSelectElement>(
      'select[aria-label="单证类型 po-001.pdf"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(typeSelect, "po");
      typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const notes = document.querySelector<HTMLInputElement>(
      'input[aria-label="单证备注 po-001.pdf"]',
    )!;
    const inputSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      inputSetter?.call(notes, "客户原始 PO");
      notes.dispatchEvent(new Event("input", { bubbles: true }));
    });

    clickButton("创建订单");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[0]![0]).toBe("/orders");
    const [url, form, config] = mocks.post.mock.calls[1]!;
    expect(url).toBe("/external-docs");
    expect(form).toBeInstanceOf(FormData);
    const body = form as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
    expect(body.get("doc_type")).toBe("po");
    expect(body.get("order_id")).toBe("99");
    expect(body.get("customer_id")).toBe("7");
    expect(body.get("notes")).toBe("客户原始 PO");
    expect(config).toEqual({
      headers: { "Content-Type": "multipart/form-data" },
      silent: true,
    });
  });

  it("已有单证导入失败不回滚订单：订单成功 + 明确提示去详情补导入", async () => {
    mocks.post.mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/orders") {
        return {
          data: {
            id: 99,
            order_no: "ORD-202610-0099",
            customer_name: "联佳丝网",
            status: "pending",
            currency: "EUR",
            total_amount: 1000,
          },
        };
      }
      throw new Error("upload failed");
    });
    mount(<OrderCreateWizard />);
    await settle();
    selectQuote("5");
    await settle();
    clickButton("下一步");
    await settle(2);
    clickButton("下一步");
    await settle(2);
    clickButton("下一步");
    await settle(2);
    clickButton("下一步");
    await settle();

    const fileInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="选择已有单证文件"]',
    )!;
    Object.defineProperty(fileInput, "files", {
      value: [
        new File([new Uint8Array(4)], "po.pdf", {
          type: "application/pdf",
        }),
      ],
      configurable: true,
    });
    act(() => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();

    clickButton("创建订单");
    await settle();

    const { toast } = await import("sonner");
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      expect.stringContaining("已创建"),
    );
    expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toContain(
      "已导入单证",
    );
  });
});