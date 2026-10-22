import { describe, expect, it } from "vitest";

import {
  copyCalculationRules,
  hasCalculationRules,
  makeProductKey,
  mergeWorkProducts,
  pctToRatio,
  ratioToPct,
  type ProductSpec,
} from "../tenant-products";

describe("产品工位纯逻辑（2026-10-22 傻瓜化）", () => {
  it("合并系统产品与团队自定义：同 key 时租户行优先，且只出现一次", () => {
    const rows = mergeWorkProducts(
      [
        { product_key: "chain_link", name: "勾花网", name_en: "Chain Link", media_count: 2, profile: {} },
        { product_key: "field_fence", name: "牛栏网", name_en: "Field Fence", media_count: 0, profile: {} },
      ],
      [
        {
          id: 1,
          product_key: "chain_link",
          product_name: "我们的勾花网",
          product_name_en: "Our Chain Link",
          is_active: true,
        },
        {
          id: 2,
          product_key: "custom_a",
          product_name: "自定义产品",
          is_active: false,
        },
      ],
    );
    expect(rows.map((r) => r.key)).toEqual(["chain_link", "field_fence", "custom_a"]);
    expect(rows[0]?.name).toBe("我们的勾花网");
    expect(rows[0]?.isSystem).toBe(false);
    expect(rows[1]?.isSystem).toBe(true);
    expect(rows[2]?.tenant?.is_active).toBe(false);
  });

  it("内部编号自动生成，且不与现有产品冲突", () => {
    expect(makeProductKey("Hot-dip Galvanized Fence", "热镀锌勾花网", [])).toBe(
      "hot_dip_galvanized_fence",
    );
    expect(makeProductKey("Chain Link", "勾花网", ["chain_link"])).toBe("chain_link_2");
    expect(makeProductKey("", "纯中文", [])).toMatch(/^product_/);
  });

  it("空白产品没有计算规则；复制规则只覆盖规则字段，不动名称/图片/档位", () => {
    const blank: ProductSpec = {
      key: "new_one",
      name: "新产品",
      variants: [{ name: "coating", label: "表面处理", options: [] }],
      packaging: [{ id: "p1", name: "默认包装", amount: 12 }],
    };
    expect(hasCalculationRules(blank)).toBe(false);
    const source: ProductSpec = {
      key: "chain_link",
      name: "勾花网",
      derived: [{ name: "weight_per_piece_kg", expr: "d*d*1.28/mesh*width*len" }],
      numeric_inputs: [{ key: "d", label: "丝径", default: 2.5 }],
      columns: [{ key: "weight" }],
    };
    const next = copyCalculationRules(blank, source);
    expect(hasCalculationRules(next)).toBe(true);
    expect(next.derived).toEqual(source.derived);
    expect(next.numeric_inputs).toEqual(source.numeric_inputs);
    expect(next.name).toBe("新产品");
    expect(next.variants).toEqual(blank.variants);
    expect(next.packaging).toEqual(blank.packaging);
  });

  it("百分比与小数互转", () => {
    expect(pctToRatio("6")).toBeCloseTo(0.06);
    expect(pctToRatio("")).toBeNull();
    expect(pctToRatio("abc")).toBeNull();
    expect(ratioToPct(0.08)).toBe("8");
    expect(ratioToPct(null)).toBe("");
  });
});
