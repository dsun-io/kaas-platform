/**
 * 开单表单「成品预览」（问题 6）。
 *
 * 钉住：
 * 1. 表单必填没填全时入口**禁用**，并如实列出缺哪几项（不让人点开空单据猜）；
 * 2. 打开后 iframe 用**当前表单值**（业务客户 / 币种 / 上游贸易条款）渲染成品；
 * 3. 预览**不落库**：不触发创建 mutation、不发任何 POST（开单前只是本地渲染）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock("../../hooks/use-trade-docs", () => ({
  useCreateTradeDoc: () => ({ mutateAsync: mocks.create, isPending: false }),
  // DocPreview 的归档/对账 hook：成品预览是只读的，不该触发它们
  useUploadTradeDocFile: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveRenderedPdf: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCheckTradeDocRenderFingerprint: () => ({
    mutate: vi.fn(),
    isPending: false,
    data: undefined,
    isError: false,
  }),
}));

vi.mock("@/lib/api/client", () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  apiClient: {
    get: mocks.get,
    post: mocks.post,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const ORDER = {
  id: 1,
  order_no: "SO-202610-0001",
  customer_name: "客户A",
  status: "confirmed",
  currency: "USD",
  total_amount: 12300,
  order_date: "2026-10-20",
  delivery_date: "2026-11-20",
  incoterm: "FOB Shanghai",
  payment_terms: "T/T 30% deposit, 70% before shipment",
  port_of_loading: "Shanghai",
  port_of_destination: "Hamburg",
  shipping_marks: "KAAS/ORDER1",
  country_of_origin: "China",
};

vi.mock("@/lib/workstation/use-upstream", () => ({
  useOrderOptions: () => ({ data: [ORDER] }),
  useQuoteOptions: () => ({ data: [] }),
  toCustomerIdPayload: (id: number | string) => id,
}));

// CustomerPicker 是重型远程选择器；这里只关心「已选客户」之后表单的行为
vi.mock("@/components/customer-picker", () => ({
  CustomerPicker: ({
    onChange,
  }: {
    onChange: (v: { id: string; name: string }) => void;
  }) => (
    <button
      type="button"
      data-testid="pick-customer"
      onClick={() => onChange({ id: "5", name: "客户A" })}
    >
      选择客户
    </button>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { DocCreateForm } from "../doc-create-form";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<DocCreateForm />));
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(check: () => boolean, label: string, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error(
        `等待超时：${label}（当前文本：${document.body.textContent?.slice(0, 400) ?? ""}）`,
      );
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`没找到按钮：${text}`);
  return button as HTMLButtonElement;
}

function click(node: Element | null | undefined, label: string) {
  if (!node) throw new Error(`没找到${label}`);
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setInputByLabel(labelText: string, value: string) {
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    (l.textContent ?? "").includes(labelText),
  );
  const input = label?.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error(`没找到输入框「${labelText}」`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 父对象选择器（三个 select 里唯一带「不关联（直接挂客户）」选项的那个） */
function sourceKindSelect(): HTMLSelectElement {
  const select = Array.from(document.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.textContent?.includes("不关联")),
  );
  if (!select) throw new Error("没找到父对象选择器");
  return select as HTMLSelectElement;
}

function orderSelect(): HTMLSelectElement {
  const select = Array.from(document.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.value === "1"),
  );
  if (!select) throw new Error("没找到订单选择器");
  return select as HTMLSelectElement;
}

function previewFrame(): HTMLIFrameElement {
  const frame = document.querySelector<HTMLIFrameElement>(
    '[role="dialog"] iframe',
  );
  if (!frame) throw new Error("对话框里没有预览 iframe");
  return frame;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: 1, doc_no: "CI-202610-0001" });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("DocCreateForm · 开单前成品预览", () => {
  it("必填没填全时禁用入口，并列出缺项（业务客户 / 来源订单）", async () => {
    mount();
    await settle();

    const previewButton = buttonByText("成品预览");
    expect(previewButton.disabled).toBe(true);
    const text = document.body.textContent ?? "";
    expect(text).toContain("成品预览不可用");
    expect(text).toContain("业务客户");
    expect(text).toContain("来源订单");
  });

  it("用当前表单值（客户 / 币种）渲染成品，且提交前不落库、不发 POST", async () => {
    mount();
    await settle();

    click(
      document.querySelector('[data-testid="pick-customer"]'),
      "客户选择按钮",
    );
    await settle();
    // 切到「不关联（直接挂客户）」，清掉「来源订单」这个必填
    setSelectValue(sourceKindSelect(), "none");
    await settle();
    setInputByLabel("币种", "EUR");
    await settle();

    const previewButton = buttonByText("成品预览");
    expect(previewButton.disabled).toBe(false);
    click(previewButton, "成品预览按钮");
    await waitFor(
      () => document.querySelector('[role="dialog"] iframe') !== null,
      "成品预览对话框出现",
    );

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("成品预览 · 商业发票");

    const html = previewFrame().getAttribute("srcdoc") ?? "";
    expect(html).toContain("客户A");
    expect(html).toContain("EUR");

    // 预览只是本地渲染：没有创建、没有任何 POST
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("选了来源订单后：贸易条款（FOB/装运港/目的港）来自当前表单选择", async () => {
    mount();
    await settle();

    click(
      document.querySelector('[data-testid="pick-customer"]'),
      "客户选择按钮",
    );
    await settle();
    // 默认就是「订单」来源；选中那条订单即可解除「来源订单」必填
    setSelectValue(orderSelect(), "1");
    await settle();

    click(buttonByText("成品预览"), "成品预览按钮");
    await waitFor(
      () => document.querySelector('[role="dialog"] iframe') !== null,
      "成品预览对话框出现",
    );

    const html = previewFrame().getAttribute("srcdoc") ?? "";
    expect(html).toContain("FOB Shanghai");
    expect(html).toContain("Hamburg");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
