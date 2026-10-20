import { describe, expect, it } from "vitest";

import {
  filterReceivables,
  isOverdue,
  outstandingOf,
  overdueDays,
  summarizeReceivables,
  type ReceivableRow,
} from "../summary";

function row(partial: Partial<ReceivableRow>): ReceivableRow {
  return {
    id: 1,
    order_id: 1,
    currency: "USD",
    total_amount: 1000,
    received_amount: 0,
    status: "unpaid",
    order_no: "ORD-1",
    customer_name: "Lone Star Fence Co",
    ...partial,
  };
}

describe("应收金额 · 未收/已收", () => {
  it("未收 = 总额 − 已收（2 位），多收不为负", () => {
    expect(outstandingOf(row({ total_amount: 26450, received_amount: 7935 }))).toBe(18515);
    expect(outstandingOf(row({ total_amount: 1000, received_amount: 0 }))).toBe(1000);
    expect(outstandingOf(row({ total_amount: 1000, received_amount: 1200 }))).toBe(0);
    expect(outstandingOf(row({ total_amount: null, received_amount: null }))).toBe(0);
  });

  it("汇总按币种分组（不做跨币种相加）", () => {
    const summary = summarizeReceivables([
      row({ id: 1, currency: "USD", total_amount: 1000, received_amount: 400, status: "partial" }),
      row({ id: 2, currency: "USD", total_amount: 500, received_amount: 500, status: "paid" }),
      row({ id: 3, currency: "CNY", total_amount: 7000, received_amount: 0, status: "unpaid" }),
    ]);

    expect(summary.count).toBe(3);
    expect(summary.byCurrency).toEqual([
      {
        currency: "CNY",
        total: 7000,
        received: 0,
        outstanding: 7000,
        count: 1,
      },
      {
        currency: "USD",
        total: 1500,
        received: 900,
        outstanding: 600,
        count: 2,
      },
    ]);
    expect(summary.byStatus).toEqual({ partial: 1, paid: 1, unpaid: 1 });
  });
});

describe("逾期天数 · 纯计算（注入 today，不依赖系统时钟）", () => {
  const today = new Date(2026, 9, 21); // 2026-10-21 本地

  it("到期日已过 → 整天数；当天/未来/空 → 0", () => {
    expect(overdueDays("2026-10-01", today)).toBe(20);
    expect(overdueDays("2026-10-20T02:00:00Z", today)).toBe(1);
    expect(overdueDays("2026-10-21", today)).toBe(0);
    expect(overdueDays("2026-12-01", today)).toBe(0);
    expect(overdueDays(null, today)).toBe(0);
    expect(overdueDays("not-a-date", today)).toBe(0);
  });

  it("已收清永远不算逾期；未收清且到期日已过才算", () => {
    expect(isOverdue(row({ status: "paid" }), "2026-01-01", today)).toBe(false);
    expect(isOverdue(row({ status: "partial" }), "2026-10-01", today)).toBe(true);
    expect(isOverdue(row({ status: "unpaid" }), "2026-12-01", today)).toBe(false);
    // 拿不到到期日 ⇒ 不能判逾期（页面显示「未知」）
    expect(isOverdue(row({ status: "unpaid" }), null, today)).toBe(false);
  });
});

describe("筛选 · 客户名/只看逾期（作用于已加载数据）", () => {
  const today = new Date(2026, 9, 21);
  const rows = [
    row({ id: 1, order_id: 11, customer_name: "Lone Star Fence Co", status: "unpaid" }),
    row({ id: 2, order_id: 12, customer_name: "Gulf Coast Wire Mesh", status: "partial" }),
    row({
      id: 3,
      order_id: 13,
      customer_name: "SunState Fencing",
      status: "paid",
      total_amount: 100,
      received_amount: 100,
    }),
  ];
  const due: Record<number, string | null> = {
    11: "2026-10-05", // 逾期
    12: null, // 未知
    13: "2026-01-01", // 但已收清 ⇒ 不算逾期
  };

  it("状态筛选（all/具体状态）", () => {
    expect(
      filterReceivables(rows, { status: "partial", customer: "", onlyOverdue: false }, due, today),
    ).toHaveLength(1);
    expect(
      filterReceivables(rows, { status: "all", customer: "", onlyOverdue: false }, due, today),
    ).toHaveLength(3);
  });

  it("客户名模糊（大小写不敏感）与订单号", () => {
    expect(
      filterReceivables(rows, { status: "all", customer: "lone", onlyOverdue: false }, due, today),
    ).toHaveLength(1);
    expect(
      filterReceivables(rows, { status: "all", customer: "ORD-1", onlyOverdue: false }, due, today),
    ).toHaveLength(3);
    expect(
      filterReceivables(rows, { status: "all", customer: "  ", onlyOverdue: false }, due, today),
    ).toHaveLength(3);
  });

  it("只看逾期：只保留真实逾期的行（已收清/未知不算）", () => {
    const only = filterReceivables(
      rows,
      { status: "all", customer: "", onlyOverdue: true },
      due,
      today,
    );
    expect(only.map((r) => r.id)).toEqual([1]);
  });
});
