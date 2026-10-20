import { describe, expect, it } from "vitest";

import fxSample from "../sample-data-fx.json";
import { computeFxBreakdown } from "../render";
import {
  effectivePayload,
  summarizeAmounts,
  upstreamAmountOf,
} from "../amount-summary";

/**
 * A5-W3 金额摘要条 —— **纯函数**测试（真实样例 + 容差边界 + 公式复用）。
 *
 * 真实样例（`sample-data-fx.json`）：3 行 / 汇率 6.7029 / 内陆运费 CNY 750；
 * 显式货物总值 CNY 18,195.66 / USD 2,714.60（商务谈定后与逐行合计差 -2.54 CNH 舍入）
 * ⇒ 推导应付 = 2,714.60 + round(750 / 6.7029, 2) = **USD 2,826.49**，
 * 与 `docs/TRADE_DOC_EDIT_PLAN.md` §W3 及 `render.test.ts` 的真实单据一致。
 */
const REAL_SAMPLE: Record<string, unknown> = {
  ...(fxSample.base as unknown as Record<string, unknown>),
  rounding_adjustment_cny: -2.54,
  rounding_adjustment_usd: -0.37,
  total_goods_value_cny: 18195.66,
  total_goods_value_usd: 2714.6,
  inland_freight_cny: 750,
};

describe("summarizeAmounts · 真实样例（3 行 / 6.7029 / 运费 750）", () => {
  it("行合计 CNY/USD 与应付总额、大写都按 render.ts 同口径", () => {
    const summary = summarizeAmounts({
      docType: "pi",
      data: REAL_SAMPLE,
      sources: {
        order: { total_amount: 2826.49, currency: "USD", order_no: "ORD-1" },
      },
    });

    expect(summary.hasFx).toBe(true);
    expect(summary.lineCount).toBe(3);
    // 逐行：400×25.00 / 20×366.3075 / 400×2.18
    // ⚠️ 口径细节（正是"复用 render.ts"的证明）：行金额 = round(qty × round(单价,2), 2)
    // ⇒ 366.3075 先舍成 366.31，再 ×20 = 7,326.20（不是 7,326.15）。
    expect(summary.lineCny).toBe(18198.2);
    expect(summary.goodsCny).toBe(18195.66); // 显式覆盖优先（与行合计差 -2.54 舍入）
    expect(summary.payableCny).toBe(18945.66);
    expect(summary.payableUsd).toBe(2826.49);
    expect(summary.words.amount).toBe(2826.49);
    expect(summary.words.currency).toBe("USD");
    expect(summary.words.text).toBe(
      "SAY US DOLLARS TWO THOUSAND EIGHT HUNDRED AND TWENTY-SIX AND CENTS FORTY-NINE ONLY",
    );
    // 与上游订单正好一致 ⇒ 不算超容差
    expect(summary.upstream).toEqual({
      label: "order",
      total: 2826.49,
      currency: "USD",
    });
    expect(summary.diff?.amount).toBe(0);
    expect(summary.diff?.overTolerance).toBe(false);
  });

  it("公式只来自 computeFxBreakdown（不重写）：逐项相等", () => {
    const breakdown = computeFxBreakdown("pi", REAL_SAMPLE);
    const summary = summarizeAmounts({ docType: "pi", data: REAL_SAMPLE });
    expect(breakdown).not.toBeNull();
    expect(summary.payableUsd).toBe(breakdown!.payableUsd);
    expect(summary.payableCny).toBe(breakdown!.payableCny);
    expect(summary.goodsCny).toBe(breakdown!.goodsCny);
    expect(summary.goodsUsd).toBe(breakdown!.goodsUsd);
    const lineUsd = breakdown!.lines.reduce((sum, line) => sum + line.amountUsd, 0);
    expect(summary.lineUsd).toBe(Math.round((lineUsd + Number.EPSILON) * 100) / 100);
  });

  it("改内陆运费 ⇒ 应付即时变化且超容差（红标依据）", () => {
    const changed = { ...REAL_SAMPLE, inland_freight_cny: 1750 };
    const summary = summarizeAmounts({
      docType: "pi",
      data: changed,
      sources: { order: { total_amount: 2826.49, currency: "USD" } },
    });
    // 运费 +1000 CNY ⇒ +round(1000/6.7029,2)=149.19 USD
    expect(summary.payableUsd).toBe(2975.68);
    expect(summary.diff?.amount).toBe(149.19);
    expect(summary.diff?.currency).toBe("USD");
    // 容差 = max(0.05, 2975.68×0.1%) ≈ 2.98（与核销/内核 amount_tolerance 同尺）
    expect(summary.diff?.tolerance).toBeGreaterThan(2);
    expect(summary.diff?.overTolerance).toBe(true);
  });

  it("容差内的小差额不标红（银行手续费/尾差）", () => {
    const summary = summarizeAmounts({
      docType: "pi",
      data: REAL_SAMPLE,
      // 差 1.00 USD：容差 2.83 ⇒ 不超
      sources: { order: { total_amount: 2825.49, currency: "USD" } },
    });
    expect(summary.diff?.amount).toBe(1);
    expect(summary.diff?.overTolerance).toBe(false);
  });
});

describe("summarizeAmounts · 无 fx_rate / 跨币种", () => {
  const itemsOnly = {
    currency: "CNY",
    items: [
      { qty: 400, unit_price: 25 },
      { qty: 20, unit_price: 366.3075 },
      { qty: 400, unit_price: 2.18 },
    ],
  };

  it("无 fx_rate ⇒ 只出单币种摘要，大写按单据币种", () => {
    const summary = summarizeAmounts({
      docType: "contract",
      data: itemsOnly,
      sources: { order: { total_amount: 18198.15, currency: "CNY" } },
    });
    expect(summary.hasFx).toBe(false);
    expect(summary.single).toEqual({ amount: 18198.15, currency: "CNY" });
    expect(summary.words.currency).toBe("CNY");
    expect(summary.words.amount).toBe(18198.15);
    expect(summary.lineCny).toBeNull();
    // 同币种可比 ⇒ 差额算得出来（这里正好一致）
    expect(summary.diff?.amount).toBe(0);
    expect(summary.diff?.overTolerance).toBe(false);
  });

  it("上游币种既非 USD 也非单据币种 ⇒ 不硬比（diff=null，但上游金额仍展示）", () => {
    const summary = summarizeAmounts({
      docType: "contract",
      data: { ...itemsOnly, currency: "CNY" },
      sources: { order: { total_amount: 2600, currency: "EUR" } },
    });
    expect(summary.upstream).toEqual({
      label: "order",
      total: 2600,
      currency: "EUR",
    });
    expect(summary.diff).toBeNull();
  });

  it("上游只拿到报价快照时退化到 quote（订单优先）", () => {
    expect(
      upstreamAmountOf({
        order: { total_amount: 100, currency: "USD" },
        quote: { total_amount: 200, currency: "USD" },
      }),
    ).toEqual({ label: "order", total: 100, currency: "USD" });
    expect(
      upstreamAmountOf({ quote: { total_amount: 200, currency: "USD" } }),
    ).toEqual({ label: "quote", total: 200, currency: "USD" });
    expect(upstreamAmountOf(null)).toBeNull();
  });
});

describe("effectivePayload · 编辑中 custom 叠加（受保护字段不覆盖）", () => {
  it("custom 覆盖普通字段，但 items/total_amount 不被改动", () => {
    const merged = effectivePayload(
      { currency: "USD", items: [{ qty: 1 }], total_amount: 100, remarks: "旧" },
      {
        remarks: "新",
        inland_freight_cny: 750,
        items: [{ qty: 99 }],
        total_amount: 999,
        fx_rate: 6.7029,
      },
    );
    expect(merged.remarks).toBe("新");
    expect(merged.inland_freight_cny).toBe(750);
    expect(merged.fx_rate).toBe(6.7029);
    // 受保护字段保持装配值（与后端 PROTECTED_CUSTOM_FIELDS 同口径）
    expect(merged.items).toEqual([{ qty: 1 }]);
    expect(merged.total_amount).toBe(100);
  });

  it("undefined 表示清空（删除键）", () => {
    const merged = effectivePayload({ fx_rate: 6.7029 }, { fx_rate: undefined });
    expect("fx_rate" in merged).toBe(false);
  });
});
