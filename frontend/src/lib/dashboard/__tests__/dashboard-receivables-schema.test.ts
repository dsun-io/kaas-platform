/** 应收概览响应 schema（`lib/schemas/responses.ts`）—— 防后端形状漂移。 */
import { describe, expect, it } from "vitest";

import { DashboardReceivablesResponseSchema } from "@/lib/schemas/responses";

function payload() {
  return {
    range: "30d",
    since: "2026-09-23T00:00:00+00:00",
    by_currency: [
      {
        currency: "EUR",
        total: 5000,
        received: 1000,
        outstanding: 4000,
        count: 1,
      },
      {
        currency: "USD",
        total: 20000,
        received: 15000,
        outstanding: 5000,
        count: 2,
      },
    ],
    by_status: [
      { status: "unpaid", count: 2, total: 20000 },
      { status: "paid", count: 1, total: 5000 },
    ],
    totals: { count: 3 },
  };
}

describe("DashboardReceivablesResponseSchema", () => {
  it("接受内核真实形状（按币种分组 + 状态 + totals.count）", () => {
    const parsed = DashboardReceivablesResponseSchema.safeParse(payload());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.by_currency).toHaveLength(2);
    expect(parsed.data.by_currency[0]?.currency).toBe("EUR");
    expect(parsed.data.by_currency[1]?.outstanding).toBe(5000);
    expect(parsed.data.by_status[0]?.status).toBe("unpaid");
    expect(parsed.data.totals.count).toBe(3);
  });

  it("空时间窗（空数组 + count=0）合法", () => {
    const parsed = DashboardReceivablesResponseSchema.safeParse({
      ...payload(),
      by_currency: [],
      by_status: [],
      totals: { count: 0 },
    });
    expect(parsed.success).toBe(true);
  });

  it("缺 totals / 金额是字符串 / by_currency 不是数组 ⇒ 判为漂移", () => {
    const missingTotals: Record<string, unknown> = { ...payload() };
    delete missingTotals.totals;
    expect(
      DashboardReceivablesResponseSchema.safeParse(missingTotals).success,
    ).toBe(false);

    const stringAmount = payload();
    (stringAmount.by_currency[0] as { total: unknown }).total = "5000";
    expect(
      DashboardReceivablesResponseSchema.safeParse(stringAmount).success,
    ).toBe(false);

    const notArray = payload() as Record<string, unknown>;
    notArray.by_currency = { currency: "USD" };
    expect(DashboardReceivablesResponseSchema.safeParse(notArray).success).toBe(
      false,
    );
  });
});
