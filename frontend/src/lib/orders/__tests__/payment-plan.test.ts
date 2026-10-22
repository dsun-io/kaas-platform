/**
 * 收款计划草稿逻辑（§13.3）：模板 / 比例→金额 / 改金额只提示 / 校验 / payload。
 */
import { describe, expect, it } from "vitest";

import {
  amountRatioHint,
  applyAmountChange,
  applyPaymentPlanTemplate,
  applyRatioChange,
  applyTotalChange,
  buildPaymentPlanPayload,
  detectTemplateId,
  formatAmountFromRatio,
  makePlanRow,
  ratioFromAmount,
  sumPlanAmounts,
  sumPlanRatios,
  validatePaymentPlan,
} from "../payment-plan";

describe("收款计划模板", () => {
  it("30/70 模板按总额自动算两期金额（金额 = 总额 × 比例）", () => {
    const rows = applyPaymentPlanTemplate("30_70", 1000);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.schedule_type)).toEqual([
      "deposit",
      "balance",
    ]);
    expect(rows.map((row) => row.ratioPct)).toEqual(["30", "70"]);
    expect(rows.map((row) => row.amount)).toEqual(["300.00", "700.00"]);
  });

  it("50/50 与 100% 预付；自定义 = 空计划", () => {
    expect(applyPaymentPlanTemplate("50_50", 800).map((r) => r.amount)).toEqual([
      "400.00",
      "400.00",
    ]);
    expect(
      applyPaymentPlanTemplate("100_prepaid", 123.45).map((r) => r.amount),
    ).toEqual(["123.45"]);
    expect(applyPaymentPlanTemplate("custom", 1000)).toEqual([]);
  });

  it("反推模板 id：30/70 能认出来，改过就是自定义", () => {
    expect(detectTemplateId(applyPaymentPlanTemplate("30_70", 1000))).toBe(
      "30_70",
    );
    const changed = applyPaymentPlanTemplate("30_70", 1000);
    changed[1] = { ...changed[1]!, ratioPct: "60" };
    expect(detectTemplateId(changed)).toBe("custom");
  });
});

describe("比例/金额联动", () => {
  it("比例变化 → 金额自动重算（并清掉手改标记）", () => {
    const row = makePlanRow({ ratioPct: "30", amount: "300" });
    const next = applyRatioChange(row, "40", 1000);
    expect(next.amount).toBe("400.00");
    expect(next.amount_touched).toBe(false);
  });

  it("改金额 → 比例不自动回写，只给提示", () => {
    const row = makePlanRow({ ratioPct: "30", amount: "300" });
    const changed = applyAmountChange(row, "350");
    expect(changed.ratioPct).toBe("30");
    expect(changed.amount).toBe("350");
    expect(changed.amount_touched).toBe(true);
    expect(amountRatioHint(changed, 1000)).toContain("35");
    expect(amountRatioHint(changed, 1000)).toContain("不一致");
    expect(amountRatioHint({ ...changed, amount: "300" }, 1000)).toBeNull();
  });

  it("总额变化只重算未手改的行；手改金额保持原值", () => {
    const rows = [
      makePlanRow({ schedule_type: "deposit", ratioPct: "30", amount: "300" }),
      makePlanRow({
        schedule_type: "balance",
        ratioPct: "70",
        amount: "999",
        amount_touched: true,
      }),
    ];
    const next = applyTotalChange(rows, 2000);
    expect(next[0]?.amount).toBe("600.00");
    expect(next[1]?.amount).toBe("999");
  });

  it("formatAmountFromRatio / ratioFromAmount 边界", () => {
    expect(formatAmountFromRatio("33.33", 300)).toBe("99.99");
    expect(formatAmountFromRatio(0, 300)).toBe("");
    expect(formatAmountFromRatio(30, 0)).toBe("");
    expect(ratioFromAmount("300", 1000)).toBe(30);
    expect(ratioFromAmount(0, 1000)).toBeNull();
    expect(ratioFromAmount(300, 0)).toBeNull();
  });
});

describe("校验与 payload", () => {
  it("比例合计 ≤ 100、金额合计≠总额只警告不报错", () => {
    const rows = applyPaymentPlanTemplate("30_70", 1000);
    const ok = validatePaymentPlan(rows, 1000);
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual([]);

    const mismatch = validatePaymentPlan(rows, 1200);
    expect(mismatch.errors).toEqual([]);
    expect(mismatch.warnings.join("")).toContain("不一致");
  });

  it("比例合计 > 100% / 空行 / 非法类型都进 errors", () => {
    const rows = [
      makePlanRow({ schedule_type: "deposit", ratioPct: "60", amount: "600" }),
      makePlanRow({ schedule_type: "balance", ratioPct: "50", amount: "500" }),
    ];
    expect(validatePaymentPlan(rows, 1100).errors.join("")).toContain("超过 100%");

    expect(
      validatePaymentPlan([makePlanRow({ schedule_type: "deposit" })], 1000)
        .errors
        .join(""),
    ).toContain("比例或金额");

    expect(
      validatePaymentPlan(
        [makePlanRow({ schedule_type: "installment", ratioPct: "10" })],
        1000,
      ).errors.join(""),
    ).toContain("类型不合法");

    expect(
      validatePaymentPlan(
        [makePlanRow({ schedule_type: "deposit", ratioPct: "130" })],
        1000,
      ).errors.join(""),
    ).toContain("0~100");
  });

  it("payload：ratio 转小数、amount 两位小数、空字段不传", () => {
    const rows = [
      makePlanRow({
        schedule_type: "deposit",
        ratioPct: "30",
        amount: "300",
        due_date: "2026-11-01",
        notes: "  定金  ",
      }),
      makePlanRow({ schedule_type: "balance", amount: "700.009" }),
    ];
    expect(buildPaymentPlanPayload(rows)).toEqual([
      {
        schedule_type: "deposit",
        ratio: 0.3,
        amount: 300,
        due_date: "2026-11-01",
        notes: "定金",
      },
      { schedule_type: "balance", amount: 700.01 },
    ]);
  });

  it("sum 汇总（空串/非法按 0）", () => {
    const rows = [
      makePlanRow({ ratioPct: "30", amount: "300" }),
      makePlanRow({ ratioPct: "", amount: "abc" }),
    ];
    expect(sumPlanAmounts(rows)).toBe(300);
    expect(sumPlanRatios(rows)).toBe(30);
  });
});
