import { describe, it, expect } from "vitest";
import {
  ExportQuoteRequestSchema,
  ExportQuoteResponseSchema,
  ExportPolicyInSchema,
  RebateRateLookupResponseSchema,
  ExportRateSetSchema,
  ExportProductListSchema,
  ExportVerifyResponseSchema,
  MetricFormulaSchema,
  ProductFormulasResponseSchema,
  ExplainRequestSchema,
  ExplainResponseSchema,
  ImportPreviewResponseSchema,
  ImportCalculateResponseSchema,
  ImportIssueSchema,
  SpecRowsReportSchema,
} from "@contracts/export-quote";

const customerResponse = {
  meta: {
    product_key: "field_fence",
    product_name: "牛栏网",
    product_name_en: "Field Fence",
    quote_date: "2026-09-24",
    valid_until: "2026-10-01",
    validity_days: 7,
    fx_rate: "6.7019",
    fx_source: "中国银行美元现汇买入价",
    currency: "CNY",
    quote_currency: "USD",
    rate_set_code: "CN-2026-09",
    term_codes: [],
    quote_as: "",
    combo_count: 48,
    orders: [
      {
        name: "o30000",
        label: "3万米",
        label_en: "30,000 m",
        total: 30000,
        unit: "m",
      },
    ],
    main_term_summary: {},
    diagnostics: [],
  },
  view: "customer",
  customer: {
    view: "customer",
    header: ["序号", "产品", "单卷售价(元/卷)"],
    rows: [[1, "牛栏网", 301.03]],
    horizontal_header: ["序号"],
    vertical_header: ["No."],
    vertical_data: [[1]],
  },
  customer_en: {
    view: "customer",
    header: ["No.", "Product", "Price per Roll (CNY)"],
    rows: [[1, "Field Fence", 301.03]],
    horizontal_header: ["No."],
    vertical_header: ["No."],
    vertical_data: [[1]],
  },
};

describe("ExportQuoteRequestSchema", () => {
  it("accepts a minimal request and defaults validity to 7 days", () => {
    const parsed = ExportQuoteRequestSchema.parse({
      product_key: "field_fence",
      fx_rate: 6.7019,
      orders: [{ total: 30000 }],
    });
    expect(parsed.validity_days).toBe(7);
    expect(parsed.currency).toBe("CNY");
    expect(parsed.quote_currency).toBe("USD");
    expect(parsed.orders[0]!.unit).toBe("m");
  });

  it("requires at least one order", () => {
    expect(
      ExportQuoteRequestSchema.safeParse({
        product_key: "field_fence",
        fx_rate: 6.7019,
        orders: [],
      }).success,
    ).toBe(false);
  });

  it("rejects non-positive fx rate", () => {
    expect(
      ExportQuoteRequestSchema.safeParse({
        product_key: "field_fence",
        fx_rate: 0,
        orders: [{ total: 30000 }],
      }).success,
    ).toBe(false);
  });

  it("rejects validity outside 1..365", () => {
    for (const days of [0, 366]) {
      expect(
        ExportQuoteRequestSchema.safeParse({
          product_key: "field_fence",
          fx_rate: 6.7,
          orders: [{ total: 1 }],
          validity_days: days,
        }).success,
      ).toBe(false);
    }
  });
});

describe("ExportPolicyInSchema", () => {
  it("accepts the business baseline (让利 80%, 出口零税率)", () => {
    const parsed = ExportPolicyInSchema.parse({
      input_vat_rate: 0.1,
      output_vat_rate: 0,
      profit_mode: "fixed",
      profit_value: 0.1,
      give_ratio: 0.8,
      refund_ratio: 1,
      stamp_rate: 0.05,
      stamp_base: "profit",
    });
    expect(parsed.give_ratio).toBe(0.8);
  });

  it("accepts refund_ratio='auto' for 退税率÷征税率", () => {
    expect(
      ExportPolicyInSchema.safeParse({ refund_ratio: "auto" }).success,
    ).toBe(true);
  });

  it("accepts adjusted national rates without code changes (13%→12%, 5%→6%)", () => {
    const parsed = ExportPolicyInSchema.parse({
      output_vat_rate: 0.12,
      stamp_rate: 0.06,
      levy_rate: 0.12,
    });
    expect(parsed.stamp_rate).toBe(0.06);
  });

  it("rejects out-of-range ratios", () => {
    expect(ExportPolicyInSchema.safeParse({ give_ratio: 1.5 }).success).toBe(
      false,
    );
    expect(ExportPolicyInSchema.safeParse({ stamp_rate: -0.1 }).success).toBe(
      false,
    );
  });
});

describe("ExportQuoteResponseSchema", () => {
  it("parses a customer view response", () => {
    const parsed = ExportQuoteResponseSchema.parse(customerResponse);
    expect(parsed.view).toBe("customer");
    expect(parsed.internal).toBeUndefined();
    expect(parsed.meta.valid_until).toBe("2026-10-01");
  });

  it("allows an internal view with the extra projection", () => {
    const parsed = ExportQuoteResponseSchema.parse({
      ...customerResponse,
      view: "internal",
      internal: { ...customerResponse.customer, header: ["税前成本(元/kg)"] },
    });
    expect(parsed.internal?.header).toEqual(["税前成本(元/kg)"]);
  });

  it("carries verification when requested", () => {
    const parsed = ExportQuoteResponseSchema.parse({
      ...customerResponse,
      verification: {
        ok: true,
        checks: 4898,
        passes: ["第1遍"],
        errors: [],
        warnings: [],
      },
    });
    expect(parsed.verification?.checks).toBe(4898);
  });
});

describe("RebateRateLookupResponseSchema", () => {
  it("treats not-found as a normal response with a hint", () => {
    const parsed = RebateRateLookupResponseSchema.parse({
      found: false,
      hs_code: "7314410000",
      rate_set_code: "CN-2026-09",
      message: "未收录该 HS 编码的出口退税率",
      hint: "请按 HS 编码在税务总局退税率文库核实后填入",
    });
    expect(parsed.found).toBe(false);
    expect(parsed.hint).toContain("核实");
  });

  it("parses a found result with provenance", () => {
    const parsed = RebateRateLookupResponseSchema.parse({
      found: true,
      hs_code: "7314410000",
      rebate_rate: 0.13,
      source: "rate_set:CN-2026-09",
      cached: false,
    });
    expect(parsed.rebate_rate).toBe(0.13);
  });
});

describe("ExportRateSetSchema", () => {
  it("parses an archive whose rebate table is still pending confirmation", () => {
    const parsed = ExportRateSetSchema.parse({
      code: "CN-2026-09",
      name: "中国大陆 · 2026年9月",
      country: "CN",
      effective_from: "2026-09-01",
      effective_to: null,
      levy_rate: 0.13,
      output_rate_export: 0,
      stamp_duty: { rate: 0.05, base: "profit" },
      summary: "加工利润 × 5.00%",
      rebate_hs_count: 3,
      rebate_default: null,
      warnings: ["档案 CN-2026-09 既没有 HS 退税率表、也没有默认退税率"],
    });
    expect(parsed.stamp_duty.base).toBe("profit");
    expect(parsed.warnings.length).toBe(1);
  });
});

describe("meta contracts", () => {
  it("parses the product list", () => {
    const parsed = ExportProductListSchema.parse({
      products: [
        {
          key: "field_fence",
          name: "牛栏网",
          combo_count: 48,
          hs_codes: ["7314410000"],
          cost_basis: "pretax",
          cost_unit: "CNY/kg",
        },
      ],
      total: 1,
    });
    expect(parsed.products[0]!.combo_count).toBe(48);
  });

  it("parses a verification report", () => {
    const parsed = ExportVerifyResponseSchema.parse({
      ok: false,
      checks: 100,
      passes: ["第1遍 Decimal"],
      errors: [{ row: 3, field: "总价", detail: "与单价×数量不符" }],
      warnings: [],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.length).toBe(1);
  });
});

const metric = (code: string, stage: "derived" | "piece" | "order") => ({
  code,
  stage,
  label: code,
  label_en: "",
  unit: "kg",
  expr: "a + b",
  decimals: 4,
  integer: false,
  note: "怎么算、为什么这么算",
});

describe("MetricFormulaSchema", () => {
  it("requires unit and note so business can read the口径", () => {
    const base = metric("wave_add_kg", "derived");
    expect(MetricFormulaSchema.safeParse(base).success).toBe(true);

    const { note: _n, ...withoutNote } = base;
    expect(MetricFormulaSchema.safeParse(withoutNote).success).toBe(false);

    const { unit: _u, ...withoutUnit } = base;
    expect(MetricFormulaSchema.safeParse(withoutUnit).success).toBe(false);

    const { expr: _e, ...withoutExpr } = base;
    expect(MetricFormulaSchema.safeParse(withoutExpr).success).toBe(false);
  });

  it("allows null decimals for intermediates that are not rounded", () => {
    const parsed = MetricFormulaSchema.parse({
      ...metric("weight_base_kg", "derived"),
      decimals: null,
    });
    expect(parsed.decimals).toBeNull();
  });

  it("only accepts the three known stages", () => {
    for (const stage of ["derived", "piece", "order"]) {
      expect(
        MetricFormulaSchema.safeParse({ ...metric("x", "derived"), stage })
          .success,
      ).toBe(true);
    }
    expect(
      MetricFormulaSchema.safeParse({
        ...metric("x", "derived"),
        stage: "nope",
      }).success,
    ).toBe(false);
  });
});

describe("ProductFormulasResponseSchema", () => {
  const payload = {
    product_key: "field_fence",
    name: "牛栏网",
    name_en: "Field Fence",
    category_code: "niulanwang",
    hs_codes: ["7314410000"],
    cost: {
      field: "raw_price",
      basis: "pretax",
      unit: "CNY/kg",
      note: "口径说明",
    },
    space: {
      axes: [
        {
          name: "height_m",
          label: "网高(m)",
          kind: "axis",
          options: [{ value: 1.2 }],
        },
      ],
      variants: [
        {
          name: "wire",
          label: "丝径方案",
          kind: "variant",
          options: [{ value: "全丝2.0", attributes: { de: 2.0 } }],
        },
      ],
      combo_count: 48,
      summary: "height_m(2)",
      formula: "网高(m)(2) × 丝径方案(3)",
    },
    calculations: {
      derived: [metric("wave_add_kg", "derived")],
      piece: [metric("price_per_piece", "piece")],
      order: [metric("volume_effective_m3", "order")],
    },
    space_deduction: {
      mode: "median",
      value: null,
      range: [2, 3],
      expr: "",
      note: "实际占用体积 = 长方体总体积 − 2~3 m³（取中位数 2.5 m³）",
    },
    invariants: [
      { label: "总价 = 单件价 × 件数", expr: "a == b", severity: "error" },
    ],
    params: [{ name: "波弯增重", value: 3, unit: "kg/100m" }],
    notes: ["说明"],
    constants: { n: 10 },
  };

  it("parses the full calculation spec", () => {
    const parsed = ProductFormulasResponseSchema.parse(payload);
    expect(parsed.space.combo_count).toBe(48);
    expect(parsed.space_deduction.range).toEqual([2, 3]);
    expect(parsed.calculations.derived[0]!.unit).toBe("kg");
  });

  it("covers the wave-bend and effective-volume口径", () => {
    const parsed = ProductFormulasResponseSchema.parse(payload);
    const all = [
      ...parsed.calculations.derived,
      ...parsed.calculations.piece,
      ...parsed.calculations.order,
    ];
    expect(all.map((m) => m.code)).toContain("wave_add_kg");
    expect(parsed.space_deduction.note).toContain("2~3");
  });
});

describe("ExplainRequest/Response 契约", () => {
  it("defaults spec to an empty object", () => {
    const parsed = ExplainRequestSchema.parse({});
    expect(parsed.spec).toEqual({});
  });

  it("parses a step-by-step response", () => {
    const parsed = ExplainResponseSchema.parse({
      product_key: "field_fence",
      product_name: "牛栏网",
      spec: { height_m: 1.2 },
      total: 30000,
      space_deduction: "2.5",
      steps: [
        {
          code: "wave_add_kg",
          label: "波弯增重(kg)",
          stage: "derived",
          expr: "wave_factor * 3 * roll_len_m / 100",
          unit: "kg",
          decimals: null,
          note: "每 100 米 +3kg",
          value: "3",
        },
        {
          code: "volume_effective_m3",
          label: "实际占用体积(m³)",
          stage: "order",
          expr: "volume_box_m3 - space_deduction",
          unit: "m³",
          decimals: 4,
          note: "扣减 2.5 m³",
          value: "29.9000",
        },
      ],
      price_metrics_omitted: ["total_price"],
      price_hint: "请调用 /calculate",
    });
    expect(parsed.steps.length).toBe(2);
    expect(parsed.steps[1]!.value).toBe("29.9000");
    expect(parsed.price_metrics_omitted).toEqual(["total_price"]);
  });

  it("allows a null value with an error reason", () => {
    const parsed = ExplainResponseSchema.parse({
      product_key: "field_fence",
      product_name: "牛栏网",
      spec: {},
      total: null,
      space_deduction: "2.5",
      steps: [{ ...metric("x", "derived"), value: null, error: "缺少变量" }],
    });
    expect(parsed.steps[0]!.value).toBeNull();
    expect(parsed.steps[0]!.error).toBe("缺少变量");
  });
});

describe("表格批量导入契约", () => {
  it("导入问题要能指到具体行列与期望值", () => {
    const parsed = ImportIssueSchema.parse({
      row: 2,
      column: "丝径方案",
      value: "乱写的方案",
      message: "无法识别的取值；可选: 全丝2.0, 全丝2.5, 边丝2.5+内丝2.0",
      severity: "error",
    });
    expect(parsed.row).toBe(2);
    expect(parsed.column).toBe("丝径方案");
    expect(parsed.severity).toBe("error");
  });

  it("预览回报列映射与忽略列", () => {
    const parsed = ImportPreviewResponseSchema.parse({
      product_key: "field_fence",
      product_name: "牛栏网",
      source_name: "spec.csv",
      total_data_rows: 3,
      usable_rows: 2,
      error_count: 1,
      warning_count: 0,
      mapping: { "竖丝间距(cm)": "mesh_mm", 丝径方案: "wire" },
      ignored_columns: ["备注"],
      issues: [
        {
          row: 2,
          column: "丝径方案",
          value: "乱写",
          message: "无法识别",
          severity: "error",
        },
      ],
      rows: [{ height_m: 1.2, mesh_mm: 100, wire: "全丝2.0" }],
      expected_columns: ["丝径方案", "镀锌量", "工艺"],
    });
    expect(parsed.mapping["竖丝间距(cm)"]).toBe("mesh_mm");
    expect(parsed.ignored_columns).toEqual(["备注"]);
    expect(parsed.usable_rows).toBe(2);
  });

  it("预览允许没有行、没有问题（纯探测用）", () => {
    const parsed = ImportPreviewResponseSchema.parse({
      product_key: "field_fence",
      product_name: "牛栏网",
      total_data_rows: 0,
      usable_rows: 0,
      error_count: 0,
      warning_count: 0,
      mapping: {},
    });
    expect(parsed.rows).toEqual([]);
    expect(parsed.issues).toEqual([]);
  });

  it("行数回报能表达「提交 3 行、算 2 行、跳过 1 行」", () => {
    const parsed = SpecRowsReportSchema.parse({
      submitted: 3,
      computed: 2,
      skipped: 1,
    });
    expect(parsed.skipped).toBe(1);
  });

  it("批量计算响应 = 报价响应 + 导入摘要", () => {
    const parsed = ImportCalculateResponseSchema.parse({
      ...customerResponse,
      import: {
        source_name: "spec.csv",
        total_data_rows: 3,
        usable_rows: 2,
        skipped_rows: 1,
        mapping: { 丝径方案: "wire" },
        ignored_columns: [],
        issues: [
          {
            row: 2,
            column: "丝径方案",
            value: "乱写",
            message: "无法识别",
            severity: "error",
          },
        ],
      },
      spec_rows: { submitted: 3, computed: 2, skipped: 1 },
    });
    expect(parsed.import?.usable_rows).toBe(2);
    expect(parsed.spec_rows?.skipped).toBe(1);
    // 仍然是标准报价响应，客户视图不含 internal
    expect(parsed.view).toBe("customer");
    expect(parsed.internal).toBeUndefined();
  });

  it("显式规格行可以出现在报价请求里", () => {
    const parsed = ExportQuoteRequestSchema.parse({
      product_key: "field_fence",
      fx_rate: 6.7019,
      orders: [{ total: 30000 }],
      spec_rows: [
        {
          wire: "全丝2.0",
          height_m: 1.2,
          mesh_mm: 100,
          coating: "普锌40g/㎡",
          wave: "无波款",
        },
      ],
    });
    expect(parsed.spec_rows).toHaveLength(1);
  });

  it("历史/未知行的 row=0 表示整表级问题", () => {
    const parsed = ImportIssueSchema.parse({
      row: 0,
      column: "工艺",
      value: null,
      message: "表里没有「工艺」列",
      severity: "error",
    });
    expect(parsed.row).toBe(0);
    expect(parsed.value).toBeNull();
  });
});
