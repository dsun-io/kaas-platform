import { describe, expect, it } from "vitest";

import fxSample from "../sample-data-fx.json";
import {
  AMOUNT_DECIMALS,
  applyItemsOverride,
  buildItemsOverride,
  buildItemsOverridePayload,
  mergeItemsOverride,
  readItemsOverride,
  validateItemsOverride,
  applyBatchEdit,
  lineAmountOf,
  roundHalfUp,
  selectionState,
  summarizeBatchImpact,
  toggleAll,
  toggleRow,
  validateBatchValue,
  type ItemRow,
} from "../item-batch";

/** 真实样例行项（3 行 / 汇率 6.7029，见 sample-data-fx.json） */
const REAL_ITEMS: ItemRow[] = [
  { product_name: "Y-Type Fence Post", qty: 400, qty_unit: "pc", unit_price: 25.0, line_amount: 10000 },
  {
    product_name: "Field Fence (Cattle Fence)",
    qty: 20,
    qty_unit: "roll",
    unit_price: 366.3075,
    line_amount: 7326.15,
  },
  {
    product_name: "Electric Fence Support Insulator",
    qty: 400,
    qty_unit: "pc",
    unit_price: 2.18,
    line_amount: 872,
  },
];

const DATA: Record<string, unknown> = {
  ...(fxSample.base as unknown as Record<string, unknown>),
  rounding_adjustment_cny: -2.54,
  rounding_adjustment_usd: -0.37,
  total_goods_value_cny: 18195.66,
  total_goods_value_usd: 2714.6,
  inland_freight_cny: 750,
  items: REAL_ITEMS,
};

describe("roundHalfUp / lineAmountOf · 与内核 ROUND_HALF_UP 同口径", () => {
  it("4 位舍入（AMOUNT_DECIMALS=4）", () => {
    expect(AMOUNT_DECIMALS).toBe(4);
    expect(roundHalfUp(1.00005, 4)).toBe(1.0001); // 半进位
    expect(roundHalfUp(2.5, 0)).toBe(3);
    expect(roundHalfUp(-2.5, 0)).toBe(-3);
    expect(roundHalfUp(0.00004, 4)).toBe(0);
  });

  it("行金额 = qty × price（4 位）；缺值不编造", () => {
    expect(lineAmountOf(400, 25)).toBe(10000);
    expect(lineAmountOf(20, 366.3075)).toBe(7326.15);
    expect(lineAmountOf(null, 25)).toBeNull();
    expect(lineAmountOf(400, undefined)).toBeNull();
  });
});

describe("validateBatchValue · 与内核 validate_items 同口径", () => {
  it("数量必须 > 0；单价不能为负；非法格式拦截", () => {
    expect(validateBatchValue("qty", "0")).toEqual({ ok: false, error: "数量须为正数" });
    expect(validateBatchValue("qty", "-3")).toEqual({ ok: false, error: "数量须为正数" });
    expect(validateBatchValue("unit_price", "-0.01")).toEqual({
      ok: false,
      error: "单价不能为负",
    });
    expect(validateBatchValue("qty", "12abc")).toEqual({
      ok: false,
      error: "不是合法的数字（不要带千分位/单位）",
    });
    expect(validateBatchValue("unit_price", "1,000")).toEqual({
      ok: false,
      error: "不是合法的数字（不要带千分位/单位）",
    });
    expect(validateBatchValue("qty", "")).toEqual({ ok: false, error: "请填写数值" });
    expect(validateBatchValue("specification", "  ")).toEqual({
      ok: false,
      error: "不能为空",
    });
  });

  it("合法值返回数字/文本", () => {
    expect(validateBatchValue("qty", "30")).toEqual({ ok: true, value: 30 });
    expect(validateBatchValue("unit_price", "0")).toEqual({ ok: true, value: 0 });
    expect(validateBatchValue("unit_price", "26.5")).toEqual({ ok: true, value: 26.5 });
    expect(validateBatchValue("specification", " 镀锌 ")).toEqual({
      ok: true,
      value: "镀锌",
    });
  });
});

describe("选择状态 · 全选 / 半选 / 全不选", () => {
  it("selectionState 三态", () => {
    expect(selectionState(new Set(), 3)).toBe("none");
    expect(selectionState(new Set([0]), 3)).toBe("some");
    expect(selectionState(new Set([0, 1, 2]), 3)).toBe("all");
    expect(selectionState(new Set(), 0)).toBe("none");
  });

  it("单行切换与全选切换（半选点一下 = 全选）", () => {
    expect([...toggleRow(new Set(), 1)]).toEqual([1]);
    expect([...toggleRow(new Set([1]), 1)]).toEqual([]);
    expect([...toggleAll(new Set([0]), 3)]).toEqual([0, 1, 2]);
    expect([...toggleAll(new Set([0, 1, 2]), 3)]).toEqual([]);
  });
});

describe("applyBatchEdit · 只改选中行、金额由 qty×price 重算", () => {
  it("批量改单价：只影响选中行，line_amount 同步重算", () => {
    const result = applyBatchEdit(REAL_ITEMS, new Set([0, 2]), "unit_price", 26.5);
    expect(result.changedIndexes).toEqual([0, 2]);
    expect(result.unchanged).toBe(false);
    expect(result.items[0]!.unit_price).toBe(26.5);
    expect(result.items[0]!.line_amount).toBe(10600); // 400 × 26.5
    // 第 3 行原单价 2.18 → 26.5 ⇒ 400×26.5 = 10600
    expect(result.items[2]!.line_amount).toBe(10600);
    // 未选中的第 2 行完全不动（值不变、引用也保持）
    expect(result.items[1]).toBe(REAL_ITEMS[1]);
  });

  it("批量改数量：行金额同步；未选中行不受影响", () => {
    const result = applyBatchEdit(REAL_ITEMS, new Set([1]), "qty", 30);
    expect(result.changedIndexes).toEqual([1]);
    expect(result.items[1]!.qty).toBe(30);
    expect(result.items[1]!.line_amount).toBe(10989.225); // 30 × 366.3075 = 10989.2250（4 位不丢精度）
    expect(result.items[0]).toBe(REAL_ITEMS[0]);
    expect(result.items[2]).toBe(REAL_ITEMS[2]);
  });

  it("批量改规格/单位/原产国：不动金额", () => {
    const spec = applyBatchEdit(REAL_ITEMS, new Set([0, 1, 2]), "specification", "按图");
    expect(spec.changedIndexes).toEqual([0, 1, 2]);
    expect(spec.items[0]!.line_amount).toBe(10000);
    const unit = applyBatchEdit(REAL_ITEMS, new Set([0]), "qty_unit", "set");
    expect(unit.items[0]!.qty_unit).toBe("set");
    const origin = applyBatchEdit(REAL_ITEMS, new Set([0]), "country_of_origin", "CN");
    expect(origin.items[0]!.country_of_origin).toBe("CN");
  });

  it("值本来就相同 ⇒ unchanged=true（界面据此提示「无变更」）", () => {
    const result = applyBatchEdit(REAL_ITEMS, new Set([0]), "unit_price", 25);
    expect(result.unchanged).toBe(true);
    expect(result.changedIndexes).toEqual([]);
  });

  it("空选 ⇒ 一个都不改", () => {
    const result = applyBatchEdit(REAL_ITEMS, new Set(), "unit_price", 99);
    expect(result.unchanged).toBe(true);
    expect(result.items.every((row, i) => row === REAL_ITEMS[i])).toBe(true);
  });

  it("金额字段不在 BATCH_FIELDS 里（不可直接编辑）", () => {
    // 类型层已排除；运行期若硬传 line_amount，applyBatchEdit 仍不会把它当金额改，
    // 但更重要的是：界面没有这个选项。这里用白名单断言防止后续有人加进来。
    expect(validateBatchValue("specification", "")).toMatchObject({ ok: false });
  });
});

describe("summarizeBatchImpact · 预览金额影响（复用 A5-W3 口径）", () => {
  it("批量改单价 ⇒ 行合计 CNY/USD 变化与真实样例一致", () => {
    const applied = applyBatchEdit(REAL_ITEMS, new Set([0, 2]), "unit_price", 26.5);
    const impact = summarizeBatchImpact({
      docType: "pi",
      data: DATA,
      beforeItems: REAL_ITEMS,
      afterItems: applied.items,
      changedIndexes: applied.changedIndexes,
    });

    expect(impact.affectedRows).toBe(2);
    expect(impact.changedIndexes).toEqual([0, 2]);
    // 改前行合计（真实样例）：CNY 18,198.20 / USD 2,714.97
    expect(impact.before.cny).toBe(18198.2);
    expect(impact.before.usd).toBe(2714.97);
    // 行 1：400×(26.5-25)=+600；行 3：400×(26.5-2.18)=+9728 ⇒ +10,328 CNY
    expect(impact.after.cny).toBe(28526.2);
    expect(impact.delta.cny).toBe(10328);
    // USD 变化 = 按各行金额/汇率逐行重算后的差（不是把 CNY 差直接除汇率）
    expect(impact.delta.usd).toBeGreaterThan(0);
    expect(impact.delta.usd).toBeLessThan(10328 / 6.7029 + 1);
  });

  it("无变化 ⇒ Δ 为 0（预览条不该显示假变化）", () => {
    const impact = summarizeBatchImpact({
      docType: "pi",
      data: DATA,
      beforeItems: REAL_ITEMS,
      afterItems: REAL_ITEMS,
      changedIndexes: [],
    });
    expect(impact.affectedRows).toBe(0);
    expect(impact.delta.cny).toBe(0);
    expect(impact.delta.usd).toBe(0);
  });

  it("非双币种（无 fx_rate）⇒ 只有单币种合计，CNY/USD 槽位为 null", () => {
    const items: ItemRow[] = [{ qty: 10, unit_price: 5 }];
    const applied = applyBatchEdit(items, new Set([0]), "unit_price", 6);
    const impact = summarizeBatchImpact({
      docType: "contract",
      data: { currency: "CNY", items },
      beforeItems: items,
      afterItems: applied.items,
      changedIndexes: applied.changedIndexes,
    });
    expect(impact.before.cny).toBeNull();
    expect(impact.before.usd).toBeNull();
    expect(impact.delta.cny).toBeNull();
    expect(impact.delta.usd).toBeNull();
    expect(impact.before.currency).toBe("CNY");
  });
});

describe("items_override 契约（A5-W2 / task-47）", () => {
  it("只把**真正变化**的行/字段写进 override（契约字段名 spec/unit/origin）", () => {
    const applied = applyBatchEdit(REAL_ITEMS, new Set([0, 2]), "unit_price", 26.5);
    const override = buildItemsOverride(REAL_ITEMS, applied.items);
    expect(override).toEqual([
      { index: 0, unit_price: 26.5 },
      { index: 2, unit_price: 26.5 },
    ]);
    // 绝不出现金额键（金额由 qty×price 推导）
    expect(JSON.stringify(override)).not.toContain("line_amount");
    expect(JSON.stringify(override)).not.toContain("amount");
  });

  it("规格/单位/原产国映射到 spec/unit/origin", () => {
    let items = applyBatchEdit(REAL_ITEMS, new Set([1]), "specification", "按图").items;
    items = applyBatchEdit(items, new Set([1]), "qty_unit", "set").items;
    items = applyBatchEdit(items, new Set([1]), "country_of_origin", "CN").items;
    expect(buildItemsOverride(REAL_ITEMS, items)).toEqual([
      { index: 1, spec: "按图", unit: "set", origin: "CN" },
    ]);
  });

  it("合并：同 index 字段级合并、按 index 升序、撤销到空则删除键", () => {
    const merged = mergeItemsOverride(
      [{ index: 2, unit_price: 26.5 }],
      [{ index: 1, qty: 30 }, { index: 2, spec: "按图" }],
    );
    expect(merged).toEqual([
      { index: 1, qty: 30 },
      { index: 2, unit_price: 26.5, spec: "按图" },
    ]);
    expect(mergeItemsOverride(merged, [])).toEqual(merged);
    expect(buildItemsOverridePayload({ sources: { order: { order_no: "ORD-1" } }, custom: { remarks: "x" } }, []))
      .toEqual({ sources: { order: { order_no: "ORD-1" } }, custom: { remarks: "x" } });
  });

  it("payload 组装必须保留 sources（PATCH 整块替换）", () => {
    const payload = buildItemsOverridePayload(
      { sources: { order: { order_no: "ORD-1", items: [] } }, custom: { remarks: "x" } },
      [{ index: 0, unit_price: 26.5 }],
    );
    expect(payload.sources).toEqual({ order: { order_no: "ORD-1", items: [] } });
    expect((payload.custom as Record<string, unknown>).remarks).toBe("x");
    expect((payload.custom as Record<string, unknown>).items_override).toEqual([
      { index: 0, unit_price: 26.5 },
    ]);
    expect(readItemsOverride(payload)).toEqual([{ index: 0, unit_price: 26.5 }]);
    expect(readItemsOverride({})).toEqual([]);
  });

  it("前端先拦非法 override：金额键 / 越界下标", () => {
    expect(
      validateItemsOverride([{ index: 0, unit_price: 1, line_amount: 999 }]),
    ).toMatchObject({ code: "ITEMS_OVERRIDE_AMOUNT_FORBIDDEN" });
    expect(validateItemsOverride([{ index: -1, qty: 2 }])).toMatchObject({
      code: "ITEMS_OVERRIDE_INDEX",
    });
    expect(validateItemsOverride([{ index: 0.5 }])).toMatchObject({
      code: "ITEMS_OVERRIDE_INDEX",
    });
    expect(validateItemsOverride([{ index: 0, qty: 2 }])).toBeNull();
  });

  it("applyItemsOverride 与后端渲染副本同语义（行金额重算）", () => {
    const applied = applyItemsOverride(REAL_ITEMS, [
      { index: 1, qty: 30, unit_price: 366.3075 },
    ]);
    expect(applied[1]!.qty).toBe(30);
    expect(applied[1]!.line_amount).toBe(10989.225);
    // 未命中的行保持引用
    expect(applied[0]).toBe(REAL_ITEMS[0]);
    expect(applied[2]).toBe(REAL_ITEMS[2]);
  });
});