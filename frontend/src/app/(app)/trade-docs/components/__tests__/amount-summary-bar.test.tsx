import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import fxSample from "@/lib/trade-doc/sample-data-fx.json";

import { AmountSummaryBar } from "../amount-summary-bar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 真实样例：3 行 / 汇率 6.7029 / 内陆运费 CNY 750 ⇒ 应付 USD 2,826.49 */
const REAL_SAMPLE: Record<string, unknown> = {
  ...(fxSample.base as unknown as Record<string, unknown>),
  rounding_adjustment_cny: -2.54,
  rounding_adjustment_usd: -0.37,
  total_goods_value_cny: 18195.66,
  total_goods_value_usd: 2714.6,
  inland_freight_cny: 750,
};
const UPSTREAM = { order: { total_amount: 2826.49, currency: "USD" } };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(data: Record<string, unknown>, sources: unknown = UPSTREAM) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <AmountSummaryBar
        docType="pi"
        data={data}
        sources={sources as never}
      />,
    ),
  );
}

function rerender(data: Record<string, unknown>, sources: unknown = UPSTREAM) {
  act(() =>
    root!.render(
      <AmountSummaryBar
        docType="pi"
        data={data}
        sources={sources as never}
      />,
    ),
  );
}

function text() {
  return container?.textContent ?? "";
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("AmountSummaryBar · 只读金额摘要", () => {
  it("真实样例：行合计（CNY/USD）、应付 USD、大写与上游订单都渲染出来", () => {
    render(REAL_SAMPLE);

    const body = text();
    expect(body).toContain("金额摘要");
    expect(body).toContain("只读");
    expect(body).toContain("行合计");
    // 行合计：行金额 = round(qty × round(单价,2), 2) ⇒ 18,198.20 CNY
    expect(body).toContain("CNY 18,198.20");
    expect(body).toContain("（3 行）");
    expect(body).toContain("应付");
    expect(body).toContain("USD 2,826.49");
    expect(body).toContain(
      "SAY US DOLLARS TWO THOUSAND EIGHT HUNDRED AND TWENTY-SIX AND CENTS FORTY-NINE ONLY",
    );
    expect(body).toContain("上游订单");
    expect(body).toContain("USD 2,826.49");
    // 正好一致 ⇒ 绿标文案
    expect(body).toContain("与订单一致");
    // 只读：整条里没有任何可编辑控件
    expect(container!.querySelector("input")).toBeNull();
    expect(container!.querySelector("select")).toBeNull();
    expect(container!.querySelector("textarea")).toBeNull();
  });

  it("改内陆运费 ⇒ 摘要即时变化，超容差出现红标（role=alert + destructive）", () => {
    render(REAL_SAMPLE);
    expect(text()).toContain("USD 2,826.49");
    expect(container!.querySelector('[role="alert"]')).toBeNull();

    rerender({ ...REAL_SAMPLE, inland_freight_cny: 1750 });

    const body = text();
    // 运费 +1000 CNY ⇒ +149.19 USD
    expect(body).toContain("USD 2,975.68");
    expect(body).not.toContain("USD 2,826.49 / CNY"); // 旧应付不再出现（大写行仍是旧值以外的金额）
    const alert = container!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("与订单差 +149.19 USD");
    expect(alert!.className).toContain("text-destructive");
  });

  it("差额在容差内时不标红（只给灰/绿提示）", () => {
    render(REAL_SAMPLE, { order: { total_amount: 2825.49, currency: "USD" } });
    expect(text()).toContain("与订单差 +1.00 USD");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it("无 fx_rate ⇒ 只显示单币种摘要（不伪造 USD）", () => {
    render(
      {
        currency: "CNY",
        items: [{ qty: 400, unit_price: 25 }],
      },
      { order: { total_amount: 10000, currency: "CNY" } },
    );
    const body = text();
    expect(body).toContain("行合计");
    expect(body).toContain("CNY 10,000.00");
    expect(body).toContain("无汇率，仅单币种摘要");
    expect(body).not.toContain("USD");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it("没有上游快照时不显示「与订单差」（不编造基准）", () => {
    render(REAL_SAMPLE, null);
    expect(text()).not.toContain("上游");
    expect(text()).not.toContain("与订单");
  });
});
