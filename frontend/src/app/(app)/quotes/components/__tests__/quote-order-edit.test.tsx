/**
 * 报价单编辑弹窗（设计 §9.3）：
 *   · draft + 无下游：行项整批替换（PUT /quotes/{id}/items，保留成本分解）+ 条款/状态 PATCH；
 *   · 已转订单/已开单证（quote_no_editable=false）：行项/条款只读，明示锁定原因，保存只走 PATCH；
 *   · 状态流转只给合法下一状态（draft → sent/expired）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  patch: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, put: mocks.put, patch: mocks.patch },
  apiClient: { get: mocks.get, put: mocks.put, patch: mocks.patch },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { QuoteOrderEditDialog } from "../quote-order-edit-dialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function quote(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    quote_no: "QUO-1",
    quote_no_editable: true,
    customer_id: "7",
    customer_name: "联佳丝网",
    inquiry_id: 4,
    status: "draft",
    currency: "USD",
    total_amount: 1000,
    valid_until: null,
    notes: null,
    fx_rate: null,
    fx_rate_date: null,
    tax_archive_id: null,
    tax_archive_code: null,
    tax_archive_name: null,
    tax_snapshot: null,
    created_at: "2026-10-20T00:00:00Z",
    created_by: "1",
    owner_id: "1",
    owner_scope: "private",
    item_count: 1,
    incoterm: "FOB",
    payment_terms: "30% T/T",
    port_of_loading: null,
    port_of_destination: null,
    shipping_marks: null,
    country_of_origin: null,
    ...overrides,
  };
}

const ITEMS = [
  {
    id: 11,
    quote_order_id: 1,
    sku_id: null,
    product_name: "勾花网",
    spec_snapshot: { specification: "2.5mm", hs_code: "7314" },
    qty: 10,
    qty_unit: "ROLLS",
    unit_price: 100,
    currency: "USD",
    line_amount: 1000,
    sort_order: 0,
    cost_breakdown: { currency_cny_per_m2: { cost_pretax: 8.75 } },
    created_at: null,
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;
let currentQuote: Record<string, unknown> = quote();

async function settle(times = 4) {
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
      <QuoteOrderEditDialog
        open
        quote={currentQuote as never}
        items={ITEMS as never}
        onClose={() => {}}
      />
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

function setSelect(label: string, value: string) {
  const el = document.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`没找到选择器「${label}」`);
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
  currentQuote = quote();
  mocks.put.mockResolvedValue({
    data: { id: 1, total_amount: 1200, items: [] },
  });
  mocks.patch.mockResolvedValue({ data: quote() });
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

describe("draft 报价单编辑", () => {
  it("改行项 ⇒ PUT items（保留成本分解）；条款/状态 ⇒ PATCH", async () => {
    mount();
    await settle();
    expect(
      document.querySelector('input[aria-label="第 1 行产品"]'),
    ).not.toBeNull();
    setInput("第 1 行数量", "12");
    setInput("目的港", "Hamburg");
    setSelect("报价状态", "sent");
    await settle();
    click("保存报价单");
    await settle();

    expect(mocks.put).toHaveBeenCalledTimes(1);
    const [putUrl, putBody] = mocks.put.mock.calls[0]!;
    expect(putUrl).toBe("/quotes/1/items");
    const items = (putBody as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toMatchObject({
      product_name: "勾花网",
      qty: 12,
      unit_price: 100,
      line_amount: 1200,
      sort_order: 0,
      cost_breakdown: { currency_cny_per_m2: { cost_pretax: 8.75 } },
    });
    expect(items[0]?.spec_snapshot).toMatchObject({
      specification: "2.5mm",
      hs_code: "7314",
    });

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    const [patchUrl, patchBody] = mocks.patch.mock.calls[0]!;
    expect(patchUrl).toBe("/quotes/1");
    expect(patchBody).toMatchObject({
      port_of_destination: "Hamburg",
      status: "sent",
    });
  });
});

describe("锁定报价单", () => {
  it("已转订单/已开单证：行项与条款只读，明示原因，保存不 PUT items", async () => {
    currentQuote = quote({ quote_no_editable: false, status: "accepted" });
    mount();
    await settle();
    const text = document.body.textContent ?? "";
    expect(text).toContain("已转为订单或已开出 PI/合同等后续单证");
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="第 1 行产品"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="贸易术语"]')
        ?.disabled,
    ).toBe(true);
    expect(button("添加产品行")).toBeUndefined();

    click("保存报价单");
    await settle();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });

  it("已签发（sent）同样锁定行项：原因写明「签发后是法律凭证」", async () => {
    currentQuote = quote({ status: "sent" });
    mount();
    await settle();
    expect(document.body.textContent).toContain("签发后是法律凭证");
  });
});

describe("状态流转选项", () => {
  it("draft 只给 已发送 / 已过期 两个合法下一状态", async () => {
    mount();
    await settle();
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="报价状态"]',
    );
    const labels = Array.from(select?.options ?? []).map(
      (option) => option.textContent,
    );
    expect(labels).toEqual(["保持「草稿」", "已发送", "已过期"]);
  });
});
