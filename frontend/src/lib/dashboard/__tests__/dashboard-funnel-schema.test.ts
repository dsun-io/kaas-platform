/** 商机漏斗响应 schema（`lib/schemas/responses.ts`）—— 防后端形状漂移。 */
import { describe, expect, it } from "vitest";

import { DashboardFunnelResponseSchema } from "@/lib/schemas/responses";

function payload() {
  return {
    range: "30d",
    since: "2026-09-23T00:00:00+00:00",
    funnel: {
      stages: [
        { name: "inquiry", label: "询盘", count: 20 },
        { name: "quoted", label: "已报价", count: 12 },
        { name: "ordered", label: "已下单", count: 5 },
        { name: "completed", label: "已成笔", count: 3, amount: 42000 },
      ],
      conversion_rates: {
        inquiry_to_quote: 60,
        quote_to_order: 41.67,
        order_to_completed: 60,
        inquiry_to_completed: null,
      },
      composite_score: 94,
    },
    channels: [
      {
        channel: "alibaba",
        inquiry_count: 10,
        quote_count: 6,
        order_count: 3,
        completed_count: 2,
        conversion_rates: { inquiry_to_order: 30, inquiry_to_completed: null },
        composite_score: 52,
      },
    ],
    direct_orders: { count: 2, amount: 18000.5 },
    deprecated_summary: false,
  };
}

describe("DashboardFunnelResponseSchema", () => {
  it("接受内核真实形状，并把 null 转化率原样保留（不是 0）", () => {
    const parsed = DashboardFunnelResponseSchema.safeParse(payload());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.funnel.stages).toHaveLength(4);
    expect(parsed.data.funnel.stages[3]?.amount).toBe(42000);
    expect(parsed.data.funnel.conversion_rates.inquiry_to_completed).toBeNull();
    expect(
      parsed.data.channels[0]?.conversion_rates.inquiry_to_completed,
    ).toBeNull();
    expect(parsed.data.direct_orders.amount).toBe(18000.5);
  });

  it("funnel 已经带金额的阶段可以没有 amount（其余阶段不带该键）", () => {
    const data = payload();
    delete (data.funnel.stages[3] as { amount?: number }).amount;
    expect(DashboardFunnelResponseSchema.safeParse(data).success).toBe(true);
  });

  it("deprecated_summary 可缺省（兼容旧响应）", () => {
    const data: Record<string, unknown> = { ...payload() };
    delete data.deprecated_summary;
    expect(DashboardFunnelResponseSchema.safeParse(data).success).toBe(true);
  });

  it("转化率是字符串（后端改回 0 或 「60%」）时判为漂移", () => {
    const data = payload();
    (
      data.funnel.conversion_rates as { inquiry_to_quote: unknown }
    ).inquiry_to_quote = "60%";
    expect(DashboardFunnelResponseSchema.safeParse(data).success).toBe(false);
  });

  it("direct_orders.by_currency（P0-A A5）：有则按币种解析，缺省仍兼容旧响应", () => {
    // 旧响应（没有 by_currency）必须是合法形状 —— 兼容期不能把旧 mock/旧部署判红
    expect(DashboardFunnelResponseSchema.safeParse(payload()).success).toBe(
      true,
    );

    const withCurrency = payload();
    (
      withCurrency.direct_orders as {
        by_currency?: unknown;
      }
    ).by_currency = [
      { currency: "EUR", count: 1, amount: 5000 },
      { currency: "USD", count: 2, amount: 20000 },
    ];
    const parsed = DashboardFunnelResponseSchema.safeParse(withCurrency);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.direct_orders.by_currency).toEqual([
      { currency: "EUR", count: 1, amount: 5000 },
      { currency: "USD", count: 2, amount: 20000 },
    ]);
  });

  it("direct_orders.by_currency 项金额是字符串时判为漂移", () => {
    const broken = payload();
    (
      broken.direct_orders as {
        by_currency?: unknown;
      }
    ).by_currency = [{ currency: "USD", count: 2, amount: "20000" }];
    expect(DashboardFunnelResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("直接下单缺金额 / 阶段计数为字符串时判为漂移", () => {
    const missingAmount: {
      direct_orders: { count: number; amount?: number };
    } = payload();
    delete missingAmount.direct_orders.amount;
    expect(DashboardFunnelResponseSchema.safeParse(missingAmount).success).toBe(
      false,
    );

    const wrongCount = payload();
    (wrongCount.funnel.stages[0] as { count: unknown }).count = "20";
    expect(DashboardFunnelResponseSchema.safeParse(wrongCount).success).toBe(
      false,
    );
  });
});
