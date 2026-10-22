/**
 * 订单金额构成 / 货物明细纯逻辑（§13.3）。
 *
 * 钉住后端口径：amount_breakdown 只有 4 键（不存 total），订单总额 = 四项之和；
 * 历史订单无 breakdown 时回退「货物行合计 + total_amount」，不伪造费用拆分。
 */
import { describe, expect, it } from "vitest";

import {
  buildAmountBreakdown,
  formatOrderDate,
  formatOrderMoney,
  itemsVsTotalDifference,
  normalizeAmountBreakdown,
  orderItemAmount,
  orderItemSpecText,
  resolveAmountBreakdown,
  roundMoney,
  sumAmountBreakdown,
  sumItemsAmount,
  type OrderItem,
} from "../order-detail";

function item(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    product_name: "勾花网",
    qty: 10,
    qty_unit: "ROLLS",
    unit_price: 12.5,
    line_amount: 125,
    ...overrides,
  };
}

describe("金额构成", () => {
  it("4 键归一：缺失键按 0、字符串数字可解析、全空返回 null", () => {
    expect(
      normalizeAmountBreakdown({
        goods_amount: 100,
        freight_amount: 20,
        insurance_amount: 5,
        other_amount: 3,
      }),
    ).toEqual({
      goods_amount: 100,
      freight_amount: 20,
      insurance_amount: 5,
      other_amount: 3,
    });
    expect(
      normalizeAmountBreakdown({
        goods_amount: "100" as unknown as number,
      }),
    ).toEqual({
      goods_amount: 100,
      freight_amount: 0,
      insurance_amount: 0,
      other_amount: 0,
    });
    expect(normalizeAmountBreakdown(null)).toBeNull();
    expect(normalizeAmountBreakdown({})).toBeNull();
  });

  it("订单总额 = 货物 + 运费 + 保险 + 其他（build 不产 total 键）", () => {
    const breakdown = buildAmountBreakdown({
      goods: 100.006,
      freight: 20,
      insurance: 5,
      other: 3,
    });
    expect(Object.keys(breakdown)).toEqual([
      "goods_amount",
      "freight_amount",
      "insurance_amount",
      "other_amount",
    ]);
    expect(sumAmountBreakdown(breakdown)).toBe(128.01);
  });

  it("有 breakdown 时以 breakdown 为准；货物金额为 0 用行项兜底", () => {
    const resolved = resolveAmountBreakdown({
      amount_breakdown: {
        goods_amount: 0,
        freight_amount: 20,
        insurance_amount: 0,
        other_amount: 0,
      },
      items: [item({ line_amount: 100 }), item({ line_amount: 50 })],
      total_amount: 170,
    });
    expect(resolved.breakdown.goods_amount).toBe(150);
    expect(resolved.total).toBe(170);
    expect(resolved.fallback).toBe(false);
  });

  it("历史订单无 breakdown：回退货物行合计 + total_amount，并标记 fallback", () => {
    const resolved = resolveAmountBreakdown({
      amount_breakdown: null,
      items: [item({ line_amount: 125 })],
      total_amount: 125,
    });
    expect(resolved.breakdown).toEqual({
      goods_amount: 125,
      freight_amount: 0,
      insurance_amount: 0,
      other_amount: 0,
    });
    expect(resolved.total).toBe(125);
    expect(resolved.fallback).toBe(true);
  });

  it("无 breakdown 且无 total_amount：总额 = 四项之和（行项）", () => {
    const resolved = resolveAmountBreakdown({
      amount_breakdown: null,
      items: [item({ qty: 2, unit_price: 10, line_amount: null })],
      total_amount: null,
    });
    expect(resolved.total).toBe(20);
  });
});

describe("货物行金额", () => {
  it("line_amount 优先，否则 qty × unit_price；null/0 处理", () => {
    expect(orderItemAmount(item({ line_amount: 99, qty: 2, unit_price: 1 }))).toBe(
      99,
    );
    expect(
      orderItemAmount(item({ line_amount: null, qty: 3, unit_price: 4.5 })),
    ).toBe(13.5);
    expect(orderItemAmount(item({ line_amount: null, qty: null }))).toBe(0);
    expect(
      sumItemsAmount([
        item({ line_amount: 10 }),
        item({ line_amount: null, qty: 2, unit_price: 3 }),
      ]),
    ).toBe(16);
  });

  it("规格快照取 specification，其它形态回退空串", () => {
    expect(
      orderItemSpecText(
        item({ spec_snapshot: { specification: " 2.5mm 热镀锌 " } }),
      ),
    ).toBe("2.5mm 热镀锌");
    expect(orderItemSpecText(item({ spec_snapshot: { spec: "x" } }))).toBe("x");
    expect(orderItemSpecText(item({ spec_snapshot: null }))).toBe("");
  });

  it("明细合计与订单总额差异（总额未知返回 null）", () => {
    expect(itemsVsTotalDifference([item({ line_amount: 100 })], 120)).toBe(-20);
    expect(itemsVsTotalDifference([], null)).toBeNull();
  });
});

describe("展示格式", () => {
  it("金额带币种两位小数；空值显示 —", () => {
    expect(formatOrderMoney(1234.5, "USD")).toBe("USD 1,234.50");
    expect(formatOrderMoney(1234.5)).toBe("1,234.50");
    expect(formatOrderMoney(null, "USD")).toBe("—");
  });

  it("日期只保留 YYYY-MM-DD", () => {
    expect(formatOrderDate("2026-10-22T08:00:00Z")).toBe("2026-10-22");
    expect(formatOrderDate(null)).toBe("—");
  });

  it("roundMoney 容错", () => {
    expect(roundMoney(1.006)).toBe(1.01);
    expect(roundMoney(Number.NaN)).toBe(0);
  });
});
