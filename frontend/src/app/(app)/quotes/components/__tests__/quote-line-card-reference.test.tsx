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

vi.mock("../../quotations/v2-quote/hooks/use-export-quote-import", () => ({
  useExportProducts: () => ({
    data: {
      products: [
        { key: "field_fence", name: "牛栏网", name_en: "Field Fence" },
      ],
    },
    isLoading: false,
  }),
}));

vi.mock("../../quotations/v2-quote/hooks/use-export-quote-calc", () => ({
  useCalcQuote: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useProductFormulas: () => ({
    data: {
      name: "牛栏网",
      name_en: "Field Fence",
      hs_codes: ["73144100"],
      space: { axes: [], variants: [] },
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
