import { describe, expect, it } from "vitest";

import type {
  ExportProduct,
  ExportQuoteResponse,
  ProductFormulasResponse,
  QuoteTable,
} from "@contracts/export-quote";
import {
  buildLineItem,
  makeColumnIndexer,
  summarizeLines,
  applySpaceDeduction,
  visibleColumnKeys,
} from "../line-to-item";

/** 产品定义里的列：一个 internal（成本）列用来验证"客户视图自动剔除"。 */
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
          options: [{ value: 1.5, label: "1.5", label_en: "1.5 m" }],
        },
      ],
      variants: [],
      combo_count: 1,
      summary: "",
      formula: "",
    },
    piece_inputs: [],
    pricing_key: [],
    calculations: { derived: [], piece: [], order: [] },
    space_deduction: {
      mode: "fixed_per_order",
      value: 2.5,
      range: null,
      expr: "",
      note: "",
    },
    invariants: [],
    params: [],
    notes: [],
    constants: {},
    columns: [
      {
        key: "spec.product_name",
        label: "产品",
        label_en: "Product",
        decimals: null,
        internal: false,
      },
      {
        key: "derived.weight_per_piece_kg",
        label: "单卷净重(kg)",
        label_en: "Net Weight per Roll (kg)",
        decimals: 4,
        internal: false,
      },
      {
        key: "derived.volume_box_per_piece_m3",
        label: "单卷长方体体积(m³)",
        label_en: "Box Volume per Roll (m³)",
        decimals: 4,
        internal: false,
      },
      {
        key: "piece.price_per_piece_fx",
        label: "单卷美元售价(USD/卷)",
        label_en: "Price per Roll (USD/roll)",
        decimals: 4,
        internal: false,
      },
      {
        key: "price.cost_pretax",
        label: "税前成本(元/kg)",
        label_en: "",
        decimals: 4,
        internal: true,
      },
    ],
  } as unknown as ProductFormulasResponse;
}

/** 结果表：列顺序 == 产品定义列顺序（客户视图 = 剔除 internal 列后）。 */
function customerTable(): QuoteTable {
  return {
    view: "customer",
    header: [
      "产品",
      "单卷净重(kg)",
      "单卷长方体体积(m³)",
      "单卷美元售价(USD/卷)",
    ],
    rows: [["Field Fence", 30.5, 0.09, 301.03]],
    decimals: [null, 4, 4, 4],
    horizontal_header: [],
    vertical_header: [],
    vertical_data: [],
  };
}

function result(): ExportQuoteResponse {
  return {
    meta: {
      product_key: "field_fence",
      product_name: "牛栏网",
      combo_count: 1,
    },
    view: "customer",
    customer: customerTable(),
    customer_en: customerTable(),
  } as unknown as ExportQuoteResponse;
}

function product(): ExportProduct {
  return {
    key: "field_fence",
    name: "牛栏网",
    name_en: "Field Fence",
    category_code: "fence",
    combo_count: 1,
    spec_summary: "",
    hs_codes: ["73144100"],
    cost_basis: "pretax",
    cost_unit: "元/kg",
    params: [],
  };
}

describe("列定位（不按表头文字猜）", () => {
  it("客户视图剔除 internal 列，列顺序与结果表一致", () => {
    expect(visibleColumnKeys(formulas(), "customer")).toEqual([
      "spec.product_name",
      "derived.weight_per_piece_kg",
      "derived.volume_box_per_piece_m3",
      "piece.price_per_piece_fx",
    ]);
  });

  it("内部视图保留全部列（下标与内部表对齐）", () => {
    expect(makeColumnIndexer(formulas(), "internal")("price.cost_pretax")).toBe(
      4,
    );
  });

  it("产品没声明的列返回 -1（据此判定缺失，而不是取到错列）", () => {
    expect(makeColumnIndexer(formulas(), "customer")("order.volume_m3")).toBe(
      -1,
    );
  });
});

describe("buildLineItem（数量口径：卷数 × 单卷外币价）", () => {
  const base = {
    product: product(),
    formulas: formulas(),
    spec: { height_m: 1.5 },
    pieceBase: { roll_len_m: 100 },
    result: result(),
    view: "customer" as const,
    rollLengthM: 100,
  };

  it("qty=卷数、unit=ROLLS、unit_price=单卷外币价、line_amount=两者相乘", () => {
    const { item } = buildLineItem({ ...base, pieces: 12 });
    expect(item.qty).toBe(12);
    expect(item.qty_unit).toBe("ROLLS");
    expect(item.unit_price).toBe(301.03);
    expect(item.line_amount).toBeCloseTo(301.03 * 12, 10);
  });

  it("行小计不做预舍入（否则与单证 TOTAL 会差 1 分）", () => {
    // 301.03 × 3 = 903.09；若先按 2 位舍入单价再乘，结果会不同
    const { item } = buildLineItem({ ...base, pieces: 3 });
    expect(item.line_amount).toBeCloseTo(903.09, 10);
    const { item: odd } = buildLineItem({ ...base, pieces: 7 });
    expect(odd.line_amount).toBeCloseTo(301.03 * 7, 10);
  });

  it("申报要素进 spec_snapshot（单证装配层按这些键摊平，无需改后端）", () => {
    const { item } = buildLineItem({ ...base, pieces: 10 });
    const snap = item.spec_snapshot as Record<string, unknown>;
    expect(snap.hs_code).toBe("73144100");
    expect(snap.package).toBe(10);
    expect(snap.specification).toBe("Net Height (m): 1.5 m");
    expect(snap.net_weight).toBeCloseTo(30.5 * 10, 10);
    expect(snap.gross_weight).toBeCloseTo(30.5 * 10, 10); // 无包装 → 毛重=净重
    expect(snap.volume).toBeCloseTo(0.09 * 10, 10);
    expect(snap.product_name_zh).toBe("牛栏网");
  });

  it("缺 HS Code 时报告缺失，且不静默填 0 重量", () => {
    const noHs = product();
    noHs.hs_codes = [];
    const { missing } = buildLineItem({ ...base, product: noHs, pieces: 1 });
    expect(missing).toContain("hs_code");
    expect(missing).not.toContain("net_weight");
  });

  it("规格描述为空时报告缺失（单证 Specification 列不能空白）", () => {
    const { missing, item } = buildLineItem({ ...base, spec: {}, pieces: 1 });
    expect(missing).toContain("specification");
    expect((item.spec_snapshot as Record<string, unknown>).specification).toBe(
      "",
    );
  });
});

describe("汇总（与单证 TOTAL 同源：逐行求和）", () => {
  const base = {
    product: product(),
    formulas: formulas(),
    spec: { height_m: 1.5 },
    pieceBase: { roll_len_m: 100 },
    result: result(),
    view: "customer" as const,
    rollLengthM: 100,
  };

  it("总额 = Σ 行小计；总米数 = Σ(卷数 × 每卷米数)", () => {
    const a = buildLineItem({ ...base, pieces: 10 });
    const b = buildLineItem({ ...base, pieces: 4 });
    const s = summarizeLines([a, b]);
    expect(s.lineCount).toBe(2);
    expect(s.totalQty).toBe(14);
    expect(s.totalMeters).toBe(1400);
    expect(s.totalAmount).toBeCloseTo(301.03 * 14, 10);
    // 与"先各自求和再相加"完全一致（无二次舍入）
    expect(s.totalAmount).toBeCloseTo(
      (a.item.line_amount ?? 0) + (b.item.line_amount ?? 0),
      10,
    );
  });

  it("空行集合汇总为 0（不抛异常，便于界面首屏渲染）", () => {
    expect(summarizeLines([]).totalAmount).toBe(0);
  });
});

describe("体积扣减（口径由产品定义声明，不写死）", () => {
  it("声明为每单一次时才扣减", () => {
    expect(
      applySpaceDeduction(20, { mode: "fixed_per_order", value: 2.5 }),
    ).toBeCloseTo(17.5, 10);
  });

  it("未声明/非每单口径一律不扣（宁可不少算体积，也不能把客户体积算小）", () => {
    expect(applySpaceDeduction(20, null)).toBe(20);
    expect(applySpaceDeduction(20, { mode: "", value: 2.5 })).toBe(20);
    expect(applySpaceDeduction(20, { mode: "per_piece", value: 2.5 })).toBe(20);
  });

  it("扣减不会把体积算成负数", () => {
    expect(
      applySpaceDeduction(1, { mode: "fixed_per_order", value: 2.5 }),
    ).toBe(0);
  });
});

describe("spec_snapshot · 包装方式与材质（用户 2026-10-24）", () => {
  const base = {
    product: product(),
    formulas: formulas(),
    spec: { height_m: 1.5 },
    pieceBase: { roll_len_m: 100 },
    result: result(),
    view: "customer" as const,
    rollLengthM: 100,
  };

  it("包装方式按 method 留档（「包装1」这种档位名不再是唯一信息）", () => {
    const { item } = buildLineItem({
      ...base,
      pieces: 1,
      packaging: {
        id: "p1",
        name: "包装1",
        method: "托盘装",
        fee_per_piece: 5,
      },
    });
    const snap = item.spec_snapshot as Record<string, unknown>;
    expect(snap.packaging_id).toBe("p1");
    expect(snap.packaging_name).toBe("包装1");
    expect(snap.packaging_method).toBe("托盘装");
    expect(snap.packaging_fee_per_piece).toBe(5);
  });

  it("method 缺失的旧数据退回 name（快照里总有一句人能读懂的话）", () => {
    const { item } = buildLineItem({
      ...base,
      pieces: 1,
      packaging: { id: "p2", name: "包装2", method: "", fee_per_piece: 8 },
    });
    const snap = item.spec_snapshot as Record<string, unknown>;
    expect(snap.packaging_method).toBe("包装2");
  });

  it("没选包装时不写包装键（不塞 null 占位）", () => {
    const { item } = buildLineItem({ ...base, pieces: 1 });
    const snap = item.spec_snapshot as Record<string, unknown>;
    expect(snap).not.toHaveProperty("packaging_id");
    expect(snap).not.toHaveProperty("packaging_method");
  });

  it("材质有值才进快照；空白值不写", () => {
    const withMaterial = buildLineItem({
      ...base,
      pieces: 1,
      material: "镀锌",
    });
    expect(
      (withMaterial.item.spec_snapshot as Record<string, unknown>).material,
    ).toBe("镀锌");

    const blank = buildLineItem({ ...base, pieces: 1, material: "   " });
    expect(
      (blank.item.spec_snapshot as Record<string, unknown>).material,
    ).toBeUndefined();
  });
});

describe("cost_breakdown 内部分解快照（UNCERTAIN #19）", () => {
  const internalResult = {
    meta: {
      product_key: "field_fence",
      product_name: "牛栏网",
      combo_count: 1,
    },
    view: "internal",
    customer: customerTable(),
    customer_en: customerTable(),
    // 内部视图：列顺序 == 产品定义全列顺序（含 internal 列，cost_pretax 在下标 4）
    internal: {
      view: "internal",
      header: [
        "产品",
        "单卷净重(kg)",
        "单卷长方体体积(m³)",
        "单卷美元售价(USD/卷)",
        "税前成本(元/kg)",
      ],
      rows: [["Field Fence", 30.5, 0.09, 301.03, 8.75]],
      decimals: [null, 4, 4, 4, 4],
      horizontal_header: [],
      vertical_header: [],
      vertical_data: [],
    },
  } as unknown as ExportQuoteResponse;

  const baseInternal = {
    product: product(),
    formulas: formulas(),
    spec: { height_m: 1.5 },
    pieceBase: { roll_len_m: 100 },
    result: internalResult,
    view: "internal" as const,
    rollLengthM: 100,
  };

  it("internal 视图：行项带 cost_breakdown（成本列读自引擎内部表）", () => {
    const { item } = buildLineItem({ ...baseInternal, pieces: 10 });
    const bd = item.cost_breakdown as {
      view: string;
      currency_cny_per_m2: Record<string, number>;
      per_piece: { price_fx: number };
      pieces: number;
    };
    expect(bd.view).toBe("internal");
    expect(bd.currency_cny_per_m2.cost_pretax).toBe(8.75);
    expect(bd.per_piece.price_fx).toBe(301.03);
    expect(bd.pieces).toBe(10);
  });

  it("customer 视图：行项**不带** cost_breakdown（后端同样不会存出内部列）", () => {
    const { item } = buildLineItem({
      ...baseInternal,
      result: result(), // 客户视图结果
      view: "customer",
      pieces: 10,
    });
    expect(item.cost_breakdown).toBeUndefined();
  });
});

describe("本单使用的英文名（nameEn → item.product_name，A 项 2026-10-24）", () => {
  const base = {
    product: product(),
    formulas: formulas(),
    spec: { height_m: 1.5 },
    pieceBase: { roll_len_m: 100 },
    result: result(),
    view: "customer" as const,
    rollLengthM: 100,
    pieces: 1,
  };

  it("传了 nameEn → 用它（本单选中的英文名）", () => {
    expect(
      buildLineItem({ ...base, nameEn: "Cattle Fence" }).item.product_name,
    ).toBe("Cattle Fence");
  });

  it("nameEn 为空/空白/null → 回落产品默认英文名 name_en", () => {
    expect(buildLineItem({ ...base, nameEn: "" }).item.product_name).toBe(
      "Field Fence",
    );
    expect(buildLineItem({ ...base, nameEn: "   " }).item.product_name).toBe(
      "Field Fence",
    );
    expect(buildLineItem({ ...base, nameEn: null }).item.product_name).toBe(
      "Field Fence",
    );
  });

  it("产品没有 name_en → 再回落中文名（旧产品/旧后端）", () => {
    const noEn = product();
    noEn.name_en = "";
    expect(
      buildLineItem({ ...base, product: noEn, nameEn: "" }).item.product_name,
    ).toBe("牛栏网");
    // 显式给了本单英文名时，仍以选择为准
    expect(
      buildLineItem({ ...base, product: noEn, nameEn: "Cattle Fence" }).item
        .product_name,
    ).toBe("Cattle Fence");
  });

  it("名字只影响 product_name：单价/金额/规格快照不变", () => {
    const a = buildLineItem({ ...base, pieces: 3, nameEn: "Cattle Fence" });
    const b = buildLineItem({ ...base, pieces: 3, nameEn: "Field Fence" });
    expect(a.item.unit_price).toBe(b.item.unit_price);
    expect(a.item.line_amount).toBe(b.item.line_amount);
    expect(a.item.spec_snapshot).toEqual(b.item.spec_snapshot);
    expect((a.item.spec_snapshot as Record<string, unknown>).product_key).toBe(
      "field_fence",
    );
  });
});
