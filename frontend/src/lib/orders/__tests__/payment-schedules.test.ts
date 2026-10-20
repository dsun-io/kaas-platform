/**
 * 收款计划纯逻辑（C36 下期 #6/#10/#20）。
 *
 * 钉住：schedule_type 必填且枚举、ratio/amount 至少一个（后端两者都可空但会建出 0 金额）、
 * PATCH 只带实际填写的字段、错误体嵌套/扁平都能取到原因、汇总口径。
 */
import { describe, expect, it } from "vitest";

import {
  buildScheduleCreate,
  buildSchedulePatch,
  scheduleErrorText,
  summarizeSchedules,
  type PaymentSchedule,
} from "../payment-schedules";

function schedule(overrides: Partial<PaymentSchedule>): PaymentSchedule {
  return {
    id: 1,
    order_id: 9,
    trade_doc_id: null,
    schedule_type: "deposit",
    ratio: 0.3,
    amount: 100,
    currency: "USD",
    due_date: "2026-11-01",
    actual_date: null,
    status: "pending",
    fx_rate: null,
    exchange_gain_loss: null,
    notes: null,
    created_at: "2026-10-21T00:00:00Z",
    ...overrides,
  };
}

describe("buildScheduleCreate", () => {
  it("合法输入：类型 + 比例/金额（至少一个）→ 请求体只带填了的字段", () => {
    const result = buildScheduleCreate({
      schedule_type: "deposit",
      ratio: "0.3",
      amount: "",
      due_date: "2026-11-01",
      notes: "  定金  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toEqual({
      schedule_type: "deposit",
      ratio: 0.3,
      due_date: "2026-11-01",
      notes: "定金",
    });
  });

  it("缺少类型 / 非法类型 / 两者都空 / 比例越界 / 金额<=0 都本地拦", () => {
    expect(
      buildScheduleCreate({ schedule_type: "" }).ok,
    ).toBe(false);
    expect(
      buildScheduleCreate({ schedule_type: "installment" }).ok,
    ).toBe(false);
    expect(
      buildScheduleCreate({ schedule_type: "full" }).ok,
    ).toBe(false);
    expect(
      buildScheduleCreate({ schedule_type: "deposit", ratio: "1.2" }).ok,
    ).toBe(false);
    expect(
      buildScheduleCreate({ schedule_type: "deposit", amount: "0" }).ok,
    ).toBe(false);
  });
});

describe("buildSchedulePatch", () => {
  it("只带填写的字段；标记收款可带实际汇率与日期", () => {
    const result = buildSchedulePatch({
      status: "paid",
      actual_date: "2026-10-20",
      fx_rate: "6.7029",
      amount: "",
      notes: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toEqual({
      status: "paid",
      actual_date: "2026-10-20",
      fx_rate: 6.7029,
    });
  });

  it("非法 status / 负金额 / 空补丁都被拦（空补丁后端会 422 No fields）", () => {
    expect(buildSchedulePatch({ status: "refunded" }).ok).toBe(false);
    expect(buildSchedulePatch({ amount: "-1" }).ok).toBe(false);
    expect(buildSchedulePatch({ fx_rate: "0" }).ok).toBe(false);
    expect(buildSchedulePatch({}).ok).toBe(false);
  });
});

describe("scheduleErrorText", () => {
  it("409 已收款不可回退：专门文案（不是通用请求失败）", () => {
    const error = Object.assign(new Error("Conflict"), {
      response: {
        status: 409,
        data: {
          detail: {
            error: "conflict",
            code: "ILLEGAL_TRANSITION",
            field: "status",
            from: "paid",
            to: "pending",
          },
        },
      },
    });
    expect(scheduleErrorText(error)).toContain("不能改回");
    expect(scheduleErrorText(error)).toContain("已收款");
  });

  it("422 SCHEDULE_TYPE_REQUIRED 翻译成中文；扁平 detail 字符串原样透出", () => {
    expect(
      scheduleErrorText(
        Object.assign(new Error("Unprocessable"), {
          response: {
            status: 422,
            data: {
              detail: {
                error: "validation",
                code: "SCHEDULE_TYPE_REQUIRED",
                detail: "付款计划必须指定 schedule_type",
              },
            },
          },
        }),
      ),
    ).toBe("请选择收款类型（定金/尾款/全额）");
    expect(
      scheduleErrorText(
        Object.assign(new Error("Unprocessable"), {
          response: { status: 422, data: { detail: "schedule 金额不合法" } },
        }),
      ),
    ).toBe("schedule 金额不合法");
  });
});

describe("summarizeSchedules", () => {
  it("按金额汇总总额/已收/待收（null 金额按 0 计）", () => {
    const summary = summarizeSchedules([
      schedule({ id: 1, amount: 100, status: "paid" }),
      schedule({ id: 2, amount: 300, status: "pending" }),
      schedule({ id: 3, amount: null, status: "overdue" }),
    ]);
    expect(summary).toEqual({
      count: 3,
      totalAmount: 400,
      paidAmount: 100,
      pendingAmount: 300,
      paidCount: 1,
      pendingCount: 2,
    });
  });
});
