/**
 * 报价行卡 · 算价闭环（三段布局的折叠摘要 + 含税口径下发）。
 *
 * 这里的价值是**端到端钉住验收口径**：
 *  1. 勾选「按含税价」后，真正传给算价请求的是 `cost_basis: 'incl_tax'`；
 *  2. 算完收起表单后，折叠摘要按「产品信息 → 件数 → 金额」**三行**展示
 *     （用户 2026-10-24：「产品基本信息放在上边，件数金额放下面，每种不同的类型要换行展示」）。
 *
 * 算价/校验逻辑本身不在这里重测（已有 quote-line-card-reference / line-to-item 覆盖），
 * 这只验证「字段有没有真的传对 + 摘要结构」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  QuoteLineCard,
  newLineDraft,
  type LineDraft,
} from "../quote-line-card";

const captured = vi.hoisted(() => ({ payloads: [] as unknown[] }));

vi.mock("@/lib/products/use-products", () => ({
  useProductProfile: () => ({ data: undefined }),
}));

vi.mock("../../hooks/use-export-quote-import", () => ({
  useExportProducts: () => ({
    data: {
      products: [
        { key: "field_fence", name: "牛栏网", name_en: "Field Fence" },
      ],
    },
    isLoading: false,
  }),
}));

vi.mock("../../hooks/use-cost-reference", () => ({
  useProductCostReference: () => ({ data: null }),
}));

vi.mock("../../hooks/use-reference-price", () => ({
  useReferencePrice: () => ({ data: null }),
}));

// 英文名偏好（A 项）：这一层不验证偏好本身（另有 quote-line-card-name-en 用例），
// 统一给「无历史、查询已结束」——行卡据此用产品默认英文名。
vi.mock("../../hooks/use-product-name-preference", () => ({
  useProductNamePreference: () => ({
    data: { product_name: null },
    isFetched: true,
    isError: false,
  }),
}));

/** 客户视图结果表：列顺序 == 产品定义 columns（buildLineItem 按列键取值）。 */
const RESULT = {
  meta: { product_key: "field_fence", product_name: "牛栏网", combo_count: 1 },
  view: "customer",
  customer: {
    view: "customer",
    header: ["单卷净重(kg)", "单卷长方体体积(m³)", "单卷美元售价(USD/卷)"],
    rows: [[30.5, 0.09, 301.03]],
    decimals: [4, 4, 4],
    horizontal_header: [],
    vertical_header: [],
    vertical_data: [],
  },
  customer_en: {
    view: "customer",
    header: ["单卷净重(kg)", "单卷长方体体积(m³)", "单卷美元售价(USD/卷)"],
    rows: [[30.5, 0.09, 301.03]],
    decimals: [4, 4, 4],
    horizontal_header: [],
    vertical_header: [],
    vertical_data: [],
  },
};

vi.mock("../../hooks/use-export-quote-calc", () => {
  // 稳定引用：组件用 [formulas.data] 做 effect 依赖，每次新建对象会死循环。
  const data = {
    product_key: "field_fence",
    name: "牛栏网",
    name_en: "Field Fence",
    hs_codes: ["73144100"],
    cost: {
      field: "cost_cny_per_kg",
      basis: "pretax",
      unit: "CNY/kg",
      note: "到厂未税成本",
    },
    space: {
      axes: [
        {
          name: "height_m",
          label: "网高(m)",
          label_en: "Net Height (m)",
          kind: "axis",
          options: [
            { value: 1.5, label: "1.5 m", attributes: { roll_len_m: 100 } },
          ],
        },
      ],
      variants: [],
      combo_count: 1,
      summary: "",
      formula: "",
    },
    piece_inputs: [
      {
        key: "roll_len_m",
        label: "单卷米数",
        label_en: "",
        unit: "m",
        ui_unit: "m",
        ui_scale: 1,
        variant: "height_m",
        note: "",
        unit_quantity: true,
      },
    ],
    numeric_inputs: [],
    columns: [
      {
        key: "derived.weight_per_piece_kg",
        label: "单卷净重(kg)",
        internal: false,
      },
      {
        key: "derived.volume_box_per_piece_m3",
        label: "单卷长方体体积(m³)",
        internal: false,
      },
      {
        key: "piece.price_per_piece_fx",
        label: "单卷美元售价",
        internal: false,
      },
    ],
    space_deduction: null,
    packaging: [
      {
        id: "p1",
        name: "包装1",
        method: "托盘装",
        is_default: true,
        amount: 5,
        ranges: [],
        created_at: null,
        mode: "per_piece",
      },
    ],
  };
  return {
    useCalcQuote: () => ({
      isPending: false,
      mutateAsync: async (args: unknown) => {
        captured.payloads.push(args);
        return RESULT;
      },
    }),
    useProductFormulas: () => ({ data, isLoading: false }),
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

/** 受控壳：把 onChange 的 patch 合并回 line（卡片本身是受控组件）。 */
function Harness({
  onChangeSpy,
}: {
  onChangeSpy: (p: Partial<LineDraft>) => void;
}) {
  const [line, setLine] = useState<LineDraft>(() =>
    newLineDraft("field_fence"),
  );
  const onChange = (patch: Partial<LineDraft>) => {
    onChangeSpy(patch);
    setLine((prev) => ({ ...prev, ...patch }));
  };
  return (
    <QuoteLineCard
      index={0}
      line={line}
      shared={{ quoteCurrency: "USD", fxRate: "7.2" } as never}
      view="customer"
      lineCount={1}
      customerId="1"
      onChange={onChange}
      onRemove={() => {}}
    />
  );
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

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
}

/** 原生 input/select 设值 + 触发 React onChange（jsdom 下必须走原生 setter）。 */
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelect(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("QuoteLineCard 算价闭环（含税口径 + 折叠摘要三行）", () => {
  beforeEach(() => {
    captured.payloads.length = 0;
  });
  afterEach(unmount);

  it("勾选按含税价 → 请求 cost_basis='incl_tax'；算完摘要按 产品信息/件数/金额 三行", async () => {
    mount(<Harness onChangeSpy={() => {}} />);

    // 选规格（轴下拉的选项 value 是引擎取值 1.5，显示 1.5 m）
    const specSelect = Array.from(container!.querySelectorAll("select")).find(
      (s) => Array.from(s.options).some((o) => o.value === "1.5"),
    );
    expect(specSelect).toBeDefined();
    act(() => setSelect(specSelect as HTMLSelectElement, "1.5"));

    // 件数 + 成本（成本是算价前置校验）
    const piecesInput = container!.querySelector(
      'input[placeholder="请填写卷数"]',
    ) as HTMLInputElement;
    act(() => setInput(piecesInput, "3"));
    const costInput = container!.querySelector(
      'input[placeholder="请填写成本"]',
    ) as HTMLInputElement;
    act(() => setInput(costInput, "8.75"));

    // 勾选「按含税价」
    const box = container!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    act(() => {
      box.click();
    });

    // 计算本行
    const submit = Array.from(container!.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("计算本行"),
    );
    expect(submit).toBeDefined();
    await act(async () => {
      submit!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // ① 请求里成本口径是含税
    expect(captured.payloads.length).toBe(1);
    const sent = captured.payloads[0] as {
      payload: { cost_basis?: string; packaging_id?: string | null };
    };
    expect(sent.payload.cost_basis).toBe("incl_tax");
    expect(sent.payload.packaging_id).toBe("p1");

    // ② 折叠摘要出现，且三行顺序固定：产品信息 → 件数 → 金额
    const summary = container!.querySelector('[data-testid="line-summary"]');
    expect(summary).not.toBeNull();
    const productRow = container!.querySelector(
      '[data-testid="line-summary-product"]',
    )!;
    const qtyRow = container!.querySelector(
      '[data-testid="line-summary-qty"]',
    )!;
    const amountRow = container!.querySelector(
      '[data-testid="line-summary-amount"]',
    )!;
    expect(
      productRow.compareDocumentPosition(qtyRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      qtyRow.compareDocumentPosition(amountRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(productRow.textContent ?? "").toContain("规格");
    expect(productRow.textContent ?? "").toContain("包装 托盘装");
    expect(qtyRow.textContent ?? "").toContain("3 卷");
    expect(qtyRow.textContent ?? "").toContain("总数 300");
    expect(amountRow.textContent ?? "").toContain("行小计");
    expect(amountRow.textContent ?? "").toContain("含税价");
  });
});
