/**
 * 报价行卡 · 三段布局 / 包装方式 / 材质 / 含税开关（用户 2026-10-24 反馈 8/9/10）。
 *
 * 卡住的口径：
 * 1. DOM 顺序固定为「产品信息 → 件数 → 金额」（每类各成一段，不随屏宽乱序）；
 * 2. 包装下拉展示具体包装方式（`packaging[].method`），不再只显示「包装1」这类档位名；
 * 3. 材质选项来自产品资料 `info.material_options`：没有选项就不渲染下拉，
 *    选中值写回行草稿（`material`）——不参与算价；
 * 4. 成本旁的「按含税价」勾选写回行草稿（`costBasis`），由 build-request 下发 `cost_basis`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  QuoteLineCard,
  newLineDraft,
  type LineDraft,
} from "../quote-line-card";

const state = vi.hoisted(() => ({
  /** 模拟 GET /products/{key}/profile 的 info（null = 未加载/无资料） */
  materialInfo: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/products/use-products", () => ({
  useProductProfile: () => ({
    data: state.materialInfo
      ? { product_key: "field_fence", info: state.materialInfo }
      : undefined,
  }),
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

vi.mock("../../hooks/use-export-quote-calc", () => {
  // data 必须是**稳定引用**：组件用 [formulas.data] 做 effect 依赖，
  // 每次渲染都新建对象会触发 spec 重置的无限循环。
  const data = {
    name: "牛栏网",
    name_en: "Field Fence",
    hs_codes: ["73144100"],
    cost: {
      field: "cost_cny_per_kg",
      basis: "pretax",
      unit: "CNY/kg",
      note: "到厂未税成本",
    },
    space: { axes: [], variants: [], combo_count: 0, summary: "", formula: "" },
    piece_inputs: [],
    numeric_inputs: [],
    columns: [],
    space_deduction: null,
    // name 是档位名、method 才是业务上的「具体包装方式」
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
      {
        id: "p2",
        name: "包装2",
        method: "",
        is_default: false,
        amount: 8,
        ranges: [],
        created_at: null,
        mode: "per_piece",
      },
    ],
  };
  return {
    useCalcQuote: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useProductFormulas: () => ({ data, isLoading: false }),
  };
});

vi.mock("../../hooks/use-reference-price", () => ({
  useReferencePrice: () => ({ data: null }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

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

function card(
  overrides: Partial<LineDraft> = {},
  onChange: (patch: Partial<LineDraft>) => void = () => {},
) {
  return (
    <QuoteLineCard
      index={0}
      line={{ ...newLineDraft("field_fence"), ...overrides }}
      shared={{ quoteCurrency: "USD", fxRate: "7.2" } as never}
      view="customer"
      lineCount={1}
      customerId="1"
      onChange={onChange}
      onRemove={() => {}}
    />
  );
}

/** 某段落内的文本（便于按段断言，而不是全卡 textContent 混在一起）。 */
function section(name: string): HTMLElement {
  const el = container!.querySelector(
    `section[aria-label="${name}"]`,
  ) as HTMLElement | null;
  expect(el).not.toBeNull();
  return el!;
}

function optionTexts(select: HTMLSelectElement): string[] {
  return Array.from(select.querySelectorAll("option")).map(
    (o) => o.textContent ?? "",
  );
}

describe("QuoteLineCard 三段布局（产品信息 → 件数 → 金额）", () => {
  beforeEach(() => {
    state.materialInfo = null;
  });
  afterEach(unmount);

  it("三个 section 的 DOM 顺序固定：产品信息在件数前、件数在金额前", () => {
    mount(card());
    const labels = Array.from(
      container!.querySelectorAll("section[aria-label]"),
    ).map((s) => s.getAttribute("aria-label"));
    expect(labels).toEqual(["产品信息", "件数", "金额"]);
  });

  it("件数只在件数段、成本/利润率只在金额段（不再混排在同一 grid）", () => {
    mount(card());
    expect(section("产品信息").textContent ?? "").not.toContain("件数（卷）");
    expect(section("件数").textContent ?? "").toContain("件数（卷）");
    expect(section("件数").textContent ?? "").not.toContain("本行利润率");
    expect(section("金额").textContent ?? "").toContain("本行利润率");
  });
});

describe("QuoteLineCard 包装方式（展示 method 而不是档位名）", () => {
  beforeEach(() => {
    state.materialInfo = null;
  });
  afterEach(unmount);

  it("下拉选项文本用 packaging[].method；method 缺失才退回 name", () => {
    mount(card());
    const select = container!.querySelector(
      'select[id$="-packaging"]',
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(optionTexts(select!)).toEqual(["托盘装（默认）", "包装2"]);
    // 「包装1」只是档位名，不应再作为选项文本出现
    expect(optionTexts(select!).join("|")).not.toContain("包装1");
  });
});

describe("QuoteLineCard 材质（产品资料选项，不参与算价）", () => {
  afterEach(() => {
    state.materialInfo = null;
    unmount();
  });

  it("产品资料没有 material_options 时不渲染材质下拉", () => {
    state.materialInfo = null;
    mount(card());
    expect(container!.querySelector('select[id$="-material"]')).toBeNull();
  });

  it("material_options 为空数组时同样不渲染", () => {
    state.materialInfo = { material_options: [] };
    mount(card());
    expect(container!.querySelector('select[id$="-material"]')).toBeNull();
  });

  it("有选项时渲染下拉，选中值写回行草稿 material", () => {
    state.materialInfo = { material_options: ["镀锌", "PVC"] };
    const onChange = vi.fn();
    mount(card({}, onChange));
    const select = container!.querySelector(
      'select[id$="-material"]',
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(optionTexts(select!)).toEqual(["（不指定）", "镀锌", "PVC"]);
    act(() => {
      select!.value = "PVC";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ material: "PVC" });
  });

  it("已选材质回显在下拉里（受控）", () => {
    state.materialInfo = { material_options: ["镀锌", "PVC"] };
    mount(card({ material: "PVC" }));
    const select = container!.querySelector(
      'select[id$="-material"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe("PVC");
  });
});

describe("QuoteLineCard 成本口径开关（按含税价）", () => {
  beforeEach(() => {
    state.materialInfo = null;
  });
  afterEach(unmount);

  it("默认税前：勾选后写回 costBasis='incl_tax'", () => {
    const onChange = vi.fn();
    mount(card({ costOverride: "8.75" }, onChange));
    const box = container!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(false);
    expect(container!.textContent ?? "").toContain("税前成本");
    act(() => {
      box!.click();
    });
    expect(onChange).toHaveBeenCalledWith({ costBasis: "incl_tax" });
  });

  it("已选含税：勾选态回显、标签改成含税成本；取消勾选写回 pretax", () => {
    const onChange = vi.fn();
    mount(card({ costOverride: "8.75", costBasis: "incl_tax" }, onChange));
    const box = container!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(container!.textContent ?? "").toContain("含税成本");
    act(() => {
      box.click();
    });
    expect(onChange).toHaveBeenCalledWith({ costBasis: "pretax" });
  });
});
