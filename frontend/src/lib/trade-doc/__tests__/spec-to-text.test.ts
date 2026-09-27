import { describe, expect, it } from "vitest";

import type { ProductFormulasResponse } from "@contracts/export-quote";
import { buildSpecification, isSpecificationUsable } from "../spec-to-text";

/**
 * 测试用的最小产品定义：属性英文名一律来自 `label_en`，
 * 这正是被测函数"不写死产品知识"的证据 —— 换掉这些 label，输出随之改变。
 */
function formulas(): ProductFormulasResponse {
  return {
    product_key: "field_fence",
    name: "牛栏网",
    name_en: "Field Fence",
    category_code: "fence",
    hs_codes: ["73144100"],
    cost: { field: "raw_price", basis: "pretax", unit: "元/kg", note: "" },
    space: {
      axes: [
        {
          name: "height_m",
          label: "网高(m)",
          label_en: "Net Height (m)",
          kind: "axis",
          options: [
            { value: 1.2, label: "1.2", label_en: "1.2 m" },
            { value: 1.5, label: "1.5", label_en: "1.5 m" },
          ],
        },
      ],
      variants: [
        {
          name: "inner_wire",
          label: "内丝径",
          label_en: "Inner Wire Dia.",
          kind: "variant",
          options: [
            {
              value: "全丝2.0",
              label: "全丝2.0",
              label_en: "2.0 mm all wires",
              attributes: { roll_len_m: 100, roll_dia_m: 0.3 },
            },
          ],
        },
      ],
      combo_count: 2,
      summary: "",
      formula: "",
    },
    piece_inputs: [
      {
        key: "roll_len_m",
        label: "单件米数",
        label_en: "Length per Roll",
        unit: "m",
        ui_unit: "m",
        ui_scale: 1,
        variant: "inner_wire",
        note: "",
        unit_quantity: true,
      },
    ],
    pricing_key: [],
    calculations: { derived: [], piece: [], order: [] },
    space_deduction: { mode: "fixed_per_order", value: 2.5, range: null, expr: "", note: "" },
    invariants: [],
    params: [],
    notes: [],
    constants: {},
  };
}

describe("buildSpecification", () => {
  it("用产品定义的英文名拼出可读规格：分组英文名 + 候选项英文名", () => {
    const text = buildSpecification({
      formulas: formulas(),
      spec: { height_m: 1.5, inner_wire: "全丝2.0" },
    });
    expect(text).toBe(
      "Net Height (m): 1.5 m, Inner Wire Dia.: 2.0 mm all wires",
    );
  });

  it("按件改写的参数（每卷米数）必须出现在描述里", () => {
    const text = buildSpecification({
      formulas: formulas(),
      spec: { height_m: 1.2 },
      pieceBase: { roll_len_m: 50 },
    });
    expect(text).toContain("Length per Roll 50 m");
  });

  it("未选择的规格组被跳过，而不是印出空值", () => {
    const text = buildSpecification({
      formulas: formulas(),
      spec: { height_m: 1.5 },
    });
    expect(text).toBe("Net Height (m): 1.5 m");
    expect(text).not.toContain("undefined");
  });

  it("什么都取不到时返回空串（界面据此标黄，而不是印一行空白）", () => {
    const text = buildSpecification({ formulas: formulas(), spec: {} });
    expect(text).toBe("");
    expect(isSpecificationUsable(text)).toBe(false);
  });

  it("取值改了，描述随之改变（证明没有缓存/写死）", () => {
    const f = formulas();
    const a = buildSpecification({ formulas: f, spec: { height_m: 1.2 } });
    const b = buildSpecification({ formulas: f, spec: { height_m: 1.5 } });
    expect(a).not.toBe(b);
  });
});
