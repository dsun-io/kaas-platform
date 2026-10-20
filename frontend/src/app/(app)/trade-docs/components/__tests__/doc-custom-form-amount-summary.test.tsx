import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import fxSample from "@/lib/trade-doc/sample-data-fx.json";

// DocCustomForm 依赖的 hooks 全部桩掉：本用例只验"改字段 → 摘要条即时重算"
vi.mock("../../hooks/use-trade-docs", () => ({
  useUpdateTradeDoc: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/products/use-products", () => ({
  useProducts: () => ({ data: { items: [] }, isError: false }),
  // DocPhotoPicker 也读这个 hook（本用例不关心图库）
  useProductMedia: () => ({ data: { items: [] }, isLoading: false }),
}));
vi.mock("@/lib/trade-doc/use-clause-templates", () => ({
  useClauseTemplates: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { DocCustomForm } from "../doc-custom-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 真实样例（3 行 / 6.7029 / 运费 750 ⇒ 应付 2,826.49） */
const REAL_SAMPLE: Record<string, unknown> = {
  ...(fxSample.base as unknown as Record<string, unknown>),
  rounding_adjustment_cny: -2.54,
  rounding_adjustment_usd: -0.37,
  total_goods_value_cny: 18195.66,
  total_goods_value_usd: 2714.6,
  inland_freight_cny: 750,
};
const PAYLOAD = {
  sources: { order: { total_amount: 2826.49, currency: "USD" } },
  custom: {},
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function text() {
  return container?.textContent ?? "";
}

/** 按 manifest 字段名找输入框（表单里每个字段的 label 内都有 `<code>字段名</code>`） */
function inputByName(name: string): HTMLInputElement {
  const code = Array.from(container!.querySelectorAll("code")).find(
    (el) => el.textContent === name,
  );
  const input = code?.closest("label")?.querySelector("input");
  if (!input) throw new Error(`没找到字段 ${name} 的输入框`);
  return input as HTMLInputElement;
}

async function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <DocCustomForm
        docId={1}
        docType="pi"
        status="draft"
        payload={PAYLOAD}
        data={REAL_SAMPLE}
      />,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("DocCustomForm · 金额摘要条即时重算（A5-W3）", () => {
  it("表单顶部出现只读摘要；改内陆运费 ⇒ 应付与差额即时更新并超容差红标", async () => {
    mount();

    expect(text()).toContain("金额摘要");
    expect(text()).toContain("USD 2,826.49");
    expect(text()).toContain("与订单一致");
    expect(container!.querySelector('[role="alert"]')).toBeNull();

    // 改「内陆运费 CNY」：750 → 1750（字段 control=number，onChange 直接进 texts）
    await typeInto(inputByName("inland_freight_cny"), "1750");

    expect(text()).toContain("USD 2,975.68");
    expect(text()).toContain("与订单差 +149.19 USD");
    const alert = container!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.className).toContain("text-destructive");
    // 旧的**应付**不再出现（上游订单金额 2,826.49 仍应展示，那是对比基准，不是应付）
    expect(text()).not.toContain("应付 USD 2,826.49");
    expect(text()).toContain("上游订单 USD 2,826.49");
  });

  it("改汇率 ⇒ 行合计 USD 与应付同步变化（口径来自 computeFxBreakdown）", async () => {
    mount();
    expect(text()).toContain("USD 2,826.49");

    // fx_rate 6.7029 → 7.0：货物 USD 2,714.60 不变（显式），运费 750/7=107.14 ⇒ 应付 2,821.74
    await typeInto(inputByName("fx_rate"), "7");

    expect(text()).toContain("USD 2,821.74");
    expect(text()).toContain("与订单差 -4.75 USD");
  });

  it("摘要条只读：其中的金额没有任何输入控件", () => {
    mount();
    const bar = container!.querySelector('[aria-label="金额摘要（只读）"]');
    expect(bar).not.toBeNull();
    expect(bar!.querySelector("input")).toBeNull();
    expect(bar!.querySelector("select")).toBeNull();
    expect(bar!.textContent).toContain("只读");
  });
});
