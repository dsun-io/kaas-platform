/** 应收概览展示纯函数（`lib/dashboard/receivables.ts`）—— 标签 / 固定顺序 / 空态。 */
import { describe, expect, it } from "vitest";

import {
  RECEIVABLE_STATUS_ORDER,
  isEmptyReceivables,
  receivableStatusLabel,
  sortReceivableStatuses,
} from "../receivables";

describe("RECEIVABLE_STATUS_ORDER / receivableStatusLabel", () => {
  it("状态展示固定顺序 = unpaid / partial / paid（与迁移枚举一致）", () => {
    expect([...RECEIVABLE_STATUS_ORDER]).toEqual(["unpaid", "partial", "paid"]);
  });

  it("状态 → 中文标签；未知状态原样显示（不吞成「其他」）", () => {
    expect(receivableStatusLabel("unpaid")).toBe("未收");
    expect(receivableStatusLabel("partial")).toBe("部分收款");
    expect(receivableStatusLabel("paid")).toBe("已收清");
    expect(receivableStatusLabel("written_off")).toBe("written_off");
  });
});

describe("sortReceivableStatuses", () => {
  it("按固定顺序重排（不依赖接口返回顺序），未知状态排最后按字典序", () => {
    const input = [
      { status: "paid", count: 1 },
      { status: "written_off", count: 1 },
      { status: "unpaid", count: 2 },
      { status: "partial", count: 1 },
      { status: "archived", count: 1 },
    ];
    expect(sortReceivableStatuses(input).map((item) => item.status)).toEqual([
      "unpaid",
      "partial",
      "paid",
      "archived",
      "written_off",
    ]);
    // 不改原数组
    expect(input[0]?.status).toBe("paid");
  });
});

describe("isEmptyReceivables", () => {
  it("null / totals.count=0 → 空态", () => {
    expect(isEmptyReceivables(null)).toBe(true);
    expect(isEmptyReceivables({ totals: { count: 0 } })).toBe(true);
    expect(isEmptyReceivables({})).toBe(true);
  });

  it("totals.count>0 → 非空（金额为 0 但行数>0 也不能渲染成空态）", () => {
    expect(isEmptyReceivables({ totals: { count: 2 } })).toBe(false);
  });
});
