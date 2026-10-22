import { describe, expect, it } from "vitest";

import {
  describeAmountChange,
  diffChangeLines,
  resolvedNewTotal,
  sumLineAmounts,
  summarizeChangeDiffs,
} from "../diff";
import type { ChangeLine } from "../types";

function line(patch: Partial<ChangeLine>): ChangeLine {
  return {
    sku_id: 1,
    product_name: "牛栏网",
    qty: 10,
    qty_unit: "卷",
    unit_price: 100,
    currency: "USD",
    line_amount: 1000,
    ...patch,
  };
}

describe("新旧明细对比", () => {
  it("同一货物单价变化：标记 changed + 改动字段名（旧→新）", () => {
    const diffs = diffChangeLines(
      [line({})],
      [line({ unit_price: 120, line_amount: 1200 })],
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.kind).toBe("changed");
    expect(diffs[0]?.changedFields).toEqual(["单价", "金额"]);
    expect(diffs[0]?.before?.unit_price).toBe(100);
    expect(diffs[0]?.after?.unit_price).toBe(120);
  });

  it("完全相同的行标 same（容差 1e-6）", () => {
    const diffs = diffChangeLines(
      [line({})],
      [line({ unit_price: 100.0000001 })],
    );
    expect(diffs[0]?.kind).toBe("same");
    expect(diffs[0]?.changedFields).toEqual([]);
  });

  it("新增 / 删除行分别标 added / removed（新增按新明细顺序，删除追加末尾）", () => {
    const diffs = diffChangeLines(
      [line({ sku_id: 1 }), line({ sku_id: 2, product_name: "刺绳" })],
      [
        line({ sku_id: 1 }),
        line({ sku_id: 3, product_name: "刀片刺绳", line_amount: 500 }),
      ],
    );
    expect(diffs.map((d) => d.kind)).toEqual(["same", "added", "removed"]);
    expect(diffs[1]?.after?.product_name).toBe("刀片刺绳");
    expect(diffs[2]?.before?.product_name).toBe("刺绳");
  });

  it("同 SKU 重复行按出现顺序配对（不会张冠李戴）", () => {
    const diffs = diffChangeLines(
      [line({ line_amount: 100 }), line({ line_amount: 200 })],
      [line({ line_amount: 100 }), line({ line_amount: 300 })],
    );
    expect(diffs).toHaveLength(2);
    expect(diffs[0]?.kind).toBe("same");
    expect(diffs[1]?.kind).toBe("changed");
    expect(diffs[1]?.before?.line_amount).toBe(200);
    expect(diffs[1]?.after?.line_amount).toBe(300);
  });

  it("空一侧：全部新增 / 全部删除", () => {
    expect(diffChangeLines([], [line({})]).map((d) => d.kind)).toEqual([
      "added",
    ]);
    expect(diffChangeLines([line({})], []).map((d) => d.kind)).toEqual([
      "removed",
    ]);
    expect(diffChangeLines(null, null)).toEqual([]);
  });

  it("汇总计数", () => {
    const diffs = diffChangeLines(
      [line({ sku_id: 1 }), line({ sku_id: 2 })],
      [
        line({ sku_id: 1 }),
        line({ sku_id: 3, line_amount: 50 }),
        line({ sku_id: 4, line_amount: 60 }),
      ],
    );
    expect(summarizeChangeDiffs(diffs)).toEqual({
      changed: 0,
      added: 2,
      removed: 1,
      same: 1,
    });
  });
});

describe("金额变化", () => {
  it("合计：只认合法 line_amount；没有合法值 → null", () => {
    expect(
      sumLineAmounts([
        line({ line_amount: 100 }),
        line({ line_amount: 23.45 }),
      ]),
    ).toBe(123.45);
    expect(sumLineAmounts([])).toBeNull();
    expect(sumLineAmounts([line({ line_amount: null })])).toBeNull();
  });

  it("描述：金额不变 / 增加 / 减少 / 无数据", () => {
    expect(describeAmountChange([line({})], [line({})], "USD")).toBe(
      "金额不变",
    );
    expect(
      describeAmountChange(
        [line({ line_amount: 1000 })],
        [line({ line_amount: 1234 })],
        "USD",
      ),
    ).toBe("+USD 234.00");
    expect(
      describeAmountChange(
        [line({ line_amount: 1000 })],
        [line({ line_amount: 900 })],
        "USD",
      ),
    ).toBe("-USD 100.00");
    // 币种优先取新明细上的 currency
    expect(
      describeAmountChange(
        [line({ line_amount: 1 })],
        [line({ line_amount: 3, currency: "EUR" })],
      ),
    ).toBe("+EUR 2.00");
    expect(describeAmountChange([], [], "USD")).toBe("—");
  });

  it("新金额展示：响应 new_total_amount 优先，否则用新明细合计", () => {
    expect(resolvedNewTotal([line({ line_amount: 500 })], 888, "USD")).toBe(
      "USD 888.00",
    );
    expect(resolvedNewTotal([line({ line_amount: 500 })], null, "USD")).toBe(
      "USD 500.00",
    );
    expect(resolvedNewTotal([], null, "USD")).toBe("—");
  });
});
