/**
 * 收款计划纯逻辑（C36 下期 #6/#10/#20）。
 *
 * 钉住：schedule_type 必填且枚举、ratio/amount 至少一个（后端两者都可空但会建出 0 金额）、
 * PATCH 只带实际填写的字段、错误体嵌套/扁平都能取到原因、汇总口径。
 */
import { describe, expect, it } from "vitest";

import {
  buildReceiptCreate,
  buildScheduleCreate,
  buildSchedulePatch,
  effectiveScheduleStatus,
  isHistoricalPaidNoReceipt,
  receiptErrorText,
  receiptsForSchedule,
  receivedAmountForSchedule,
  scheduleDifference,
  scheduleErrorText,
  summarizeReceipts,
  summarizeSchedules,
  unallocatedReceipts,
  type PaymentReceipt,
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
      partialCount: 0,
    });
  });
});

function receipt(overrides: Partial<PaymentReceipt>): PaymentReceipt {
  return {
    id: 1,
    order_id: 9,
    schedule_id: 1,
    amount: 100,
    currency: "USD",
    received_date: "2026-10-20",
    fx_rate: null,
    file_id: null,
    notes: null,
    created_at: "2026-10-20T00:00:00Z",
    ...overrides,
  };
}

describe("buildReceiptCreate（§13.3 实收登记）", () => {
  it("合法输入：金额 + 日期必填；schedule_id/汇率/备注只带填了的", () => {
    const result = buildReceiptCreate({
      schedule_id: 3,
      amount: " 848.06 ",
      received_date: "2026-10-22",
      fx_rate: "6.7029",
      notes: "  第一笔到账  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toEqual({
      schedule_id: 3,
      amount: 848.06,
      received_date: "2026-10-22",
      fx_rate: 6.7029,
      notes: "第一笔到账",
    });
  });

  it("不指定期次（未分配收款）时不传 schedule_id", () => {
    const result = buildReceiptCreate({
      schedule_id: null,
      amount: "50",
      received_date: "2026-10-22",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toEqual({ amount: 50, received_date: "2026-10-22" });
  });

  it("金额必填且 >0、日期必填、汇率非法都本地拦", () => {
    expect(
      buildReceiptCreate({ amount: "", received_date: "2026-10-22" }).ok,
    ).toBe(false);
    expect(
      buildReceiptCreate({ amount: "0", received_date: "2026-10-22" }).ok,
    ).toBe(false);
    expect(
      buildReceiptCreate({ amount: "10", received_date: "" }).ok,
    ).toBe(false);
    expect(
      buildReceiptCreate({
        amount: "10",
        received_date: "2026-10-22",
        fx_rate: "0",
      }).ok,
    ).toBe(false);
  });

  it("后端校验错误翻成人话", () => {
    expect(
      receiptErrorText(
        Object.assign(new Error("Unprocessable"), {
          response: {
            status: 422,
            data: {
              detail: {
                error: "validation",
                code: "SCHEDULE_NOT_IN_ORDER",
              },
            },
          },
        }),
      ),
    ).toContain("不属于这张订单");
    expect(
      receiptErrorText(
        Object.assign(new Error("Unprocessable"), {
          response: { status: 422, data: { detail: "amount 不合法" } },
        }),
      ),
    ).toBe("amount 不合法");
  });
});

describe("收款计划 × 实收记录", () => {
  const schedulePaid = schedule({ id: 2, amount: 300, status: "paid" });

  it("某期已收：receipts 合计优先；无 receipts 时历史 paid 取 amount", () => {
    const receipts = [
      receipt({ id: 1, schedule_id: 1, amount: 60 }),
      receipt({ id: 2, schedule_id: 1, amount: 40 }),
      receipt({ id: 3, schedule_id: 2, amount: 999 }),
    ];
    expect(receiptsForSchedule(receipts, 1)).toHaveLength(2);
    expect(receivedAmountForSchedule(schedule({ id: 1 }), receipts)).toBe(100);
    // schedulePaid 没 receipts：历史兼容，按该期 amount 计入
    expect(receivedAmountForSchedule(schedulePaid, [])).toBe(300);
    // 后端给了 received_amount 时优先用它
    expect(
      receivedAmountForSchedule(
        schedule({ id: 1, received_amount: 55, status: "partial" }),
        [],
      ),
    ).toBe(55);
  });

  it("期次状态推导：pending/partial/paid；已收满但后端仍 pending ⇒ paid", () => {
    expect(effectiveScheduleStatus(schedule({ id: 1 }), [])).toBe("pending");
    expect(
      effectiveScheduleStatus(schedule({ id: 1, amount: 300 }), [
        receipt({ schedule_id: 1, amount: 100 }),
      ]),
    ).toBe("partial");
    expect(
      effectiveScheduleStatus(schedule({ id: 1, amount: 300 }), [
        receipt({ id: 1, schedule_id: 1, amount: 200 }),
        receipt({ id: 2, schedule_id: 1, amount: 100 }),
      ]),
    ).toBe("paid");
    expect(
      effectiveScheduleStatus(schedule({ id: 1, status: "overdue" }), []),
    ).toBe("overdue");
  });

  it("差异 = 实收 − 应收；应收为 null 时 null；多笔累加", () => {
    expect(
      scheduleDifference(schedule({ id: 1, amount: 300 }), [
        receipt({ schedule_id: 1, amount: 280 }),
      ]),
    ).toBe(-20);
    expect(scheduleDifference(schedule({ id: 1, amount: 300 }), [])).toBe(-300);
    expect(
      scheduleDifference(schedule({ id: 1, amount: null }), []),
    ).toBeNull();
  });

  it("历史 paid 无截图 / 未分配收款 / 实收汇总", () => {
    expect(isHistoricalPaidNoReceipt(schedulePaid, [])).toBe(true);
    expect(
      isHistoricalPaidNoReceipt(schedulePaid, [
        receipt({ schedule_id: 2, amount: 300 }),
      ]),
    ).toBe(false);

    const receipts = [
      receipt({ id: 1, schedule_id: null, amount: 70 }),
      receipt({ id: 2, schedule_id: 1, amount: 30 }),
    ];
    expect(unallocatedReceipts(receipts).map((r) => r.id)).toEqual([1]);
    expect(summarizeReceipts(receipts)).toEqual({
      count: 2,
      totalAmount: 100,
    });
  });

  it("列表汇总用实收口径：部分收款计入已收、待收按差额", () => {
    const summary = summarizeSchedules(
      [
        schedule({ id: 1, amount: 300, status: "pending" }),
        schedule({ id: 2, amount: 300, status: "paid" }),
      ],
      [receipt({ schedule_id: 1, amount: 100 })],
    );
    expect(summary.totalAmount).toBe(600);
    expect(summary.paidAmount).toBe(400); // 100 实收 + 300 历史 paid
    expect(summary.pendingAmount).toBe(200);
    expect(summary.paidCount).toBe(1);
    expect(summary.partialCount).toBe(1);
    expect(summary.pendingCount).toBe(1);
  });
});
