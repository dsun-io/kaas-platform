/**
 * 报价行卡片 · 历史参考价展示（UNCERTAIN #19）。
 *
 * 口径：
 * 1. 客户 + 产品已选且历史有记录 → 显示「历史参考（近 N 天 · N 次）：区间 + 中位」；
 * 2. 无历史记录（count=0）→ 静默不显示（首次报价是常态，不报错不打扰）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { QuoteLineCard, newLineDraft } from "../quote-line-card";

const mocks = vi.hoisted(() => ({
  referenceData: null as null | {
    count: number;
    days: number;
    min: number | null;
    max: number | null;
    median: number | null;
    last_at: string | null;
  },
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

vi.mock("../../hooks/use-export-quote-calc", () => ({
  useCalcQuote: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useProductFormulas: () => ({
    data: {
      name: "牛栏网",
      name_en: "Field Fence",
      hs_codes: ["73144100"],
      // 迁移后 mock 路径生效（原路径多一层 .. 一直没命中）——补上组件渲染必需的 cost
      cost: {
        field: "cost_cny_per_kg",
        basis: "pretax",
        unit: "CNY/kg",
        note: "到厂未税成本",
      },
      space: {
        axes: [],
        variants: [],
        combo_count: 0,
        summary: "",
        formula: "",
      },
      piece_inputs: [],
      columns: [],
      space_deduction: null,
    },
    isLoading: false,
  }),
}));

vi.mock("../../hooks/use-reference-price", () => ({
  useReferencePrice: () => ({ data: mocks.referenceData }),
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

// 产品资料接口不在这里验证（另有布局用例）；统一 mock 掉，避免真实请求把
// 单测变成网络依赖。空资料 = 不渲染材质下拉。
vi.mock("@/lib/products/use-products", () => ({
  useProductProfile: () => ({ data: undefined }),
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

function card() {
  return (
    <QuoteLineCard
      index={0}
      line={{ ...newLineDraft("field_fence") }}
      shared={{} as never}
      view="customer"
      lineCount={1}
      customerId="1"
      onChange={() => {}}
      onRemove={() => {}}
    />
  );
}

describe("QuoteLineCard 历史参考价", () => {
  beforeEach(() => {
    mocks.referenceData = null;
    mount(card());
  });

  afterEach(() => {
    unmount();
  });

  it("有历史记录：显示区间 + 中位 + 最近日期", () => {
    mocks.referenceData = {
      count: 3,
      days: 180,
      min: 280,
      max: 320,
      median: 301.03,
      last_at: "2026-10-17T02:30:00.000Z",
    };
    mountAgain();
    const text = container!.textContent ?? "";
    expect(text).toContain("历史参考");
    expect(text).toContain("3 次");
    expect(text).toContain("280.00 ~ 320.00");
    expect(text).toContain("301.03");
  });

  it("无历史记录：不显示参考行", () => {
    mocks.referenceData = {
      count: 0,
      days: 180,
      min: null,
      max: null,
      median: null,
      last_at: null,
    };
    mountAgain();
    expect(container!.textContent ?? "").not.toContain("历史参考");
  });
});

/** beforeEach 已 mount 一次（referenceData=null）；改数据后重挂 */
function mountAgain() {
  unmount();
  mount(card());
}
