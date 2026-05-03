import { describe, it, expect } from "vitest";
import {
  QuoteRequestSchema,
  QuoteResponseSchema,
  QuoteItemSchema,
  QuoteV2RequestSchema,
  QuoteV2ResponseSchema,
  TierItemSchema,
  MainLineSchema,
  FreightInfoSchema,
  AccessoryLineSchema,
  ProductSpecsOptionsSchema,
} from "@contracts/quote";

describe("QuoteRequestSchema", () => {
  it("validates a valid quote request", () => {
    const result = QuoteRequestSchema.safeParse({
      session_id: "s1",
      customer_id: "cust-1",
      items: [
        {
          product_category: "牛栏网",
          product_spec: {},
          quantity: 100,
          unit_price: null,
          confidence: "high",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative quantity", () => {
    const result = QuoteRequestSchema.safeParse({
      session_id: "s1",
      customer_id: "cust-1",
      items: [
        {
          product_category: "牛栏网",
          product_spec: {},
          quantity: -1,
          unit_price: null,
          confidence: "high",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid confidence value", () => {
    const result = QuoteRequestSchema.safeParse({
      session_id: "s1",
      customer_id: "cust-1",
      items: [
        {
          product_category: "牛栏网",
          product_spec: {},
          quantity: 100,
          unit_price: 50,
          confidence: "super_high",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("QuoteResponseSchema", () => {
  it("validates matched response with unit_price", () => {
    const result = QuoteResponseSchema.safeParse({
      session_id: "s1",
      customer_id: "cust-1",
      items: [
        {
          product_category: "牛栏网",
          product_spec: {},
          quantity: 100,
          unit_price: 12.5,
          confidence: "high",
        },
      ],
      status: "matched",
      source: "quotations_db",
    });
    expect(result.success).toBe(true);
  });

  it("validates estimated response with null unit_price", () => {
    const result = QuoteResponseSchema.safeParse({
      session_id: "s1",
      customer_id: "cust-1",
      items: [
        {
          product_category: "石笼网",
          product_spec: { mesh: "10cm" },
          quantity: 50,
          unit_price: null,
          confidence: "low",
        },
      ],
      status: "estimated",
      source: "L1_L2_formula",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown status", () => {
    const result = QuoteResponseSchema.safeParse({
      session_id: "s1",
      customer_id: "cust-1",
      items: [],
      status: "pending",
      source: "quotations_db",
    });
    expect(result.success).toBe(false);
  });
});

describe("QuoteItemSchema", () => {
  it("validates item with nullable unit_price", () => {
    const result = QuoteItemSchema.safeParse({
      product_category: "镀锌",
      product_spec: { thickness: "2mm" },
      quantity: 200,
      unit_price: null,
      confidence: "medium",
    });
    expect(result.success).toBe(true);
  });
});

// ── V2 Schemas ─────────────────────────────────────────────────────────────

describe("QuoteV2RequestSchema", () => {
  it("validates a minimal quote request", () => {
    const result = QuoteV2RequestSchema.safeParse({
      product_category: "牛栏网",
      quantity: 100,
    });
    expect(result.success).toBe(true);
  });

  it("validates a full quote request with all fields (real backend format)", () => {
    const result = QuoteV2RequestSchema.safeParse({
      product_category: "牛栏网",
      product_type: "上疏下密",
      wire_diameter: "2.5x2.0",
      height: 1.5,
      mesh_width: 15,
      roll_length: 50,
      quantity: 100,
      accessories: [
        {
          product_category: "立柱",
          product_type: "直边",
          height: 1.8,
          quantity: 50,
        },
      ],
      province: "四川",
      need_invoice: false,
      preferred_carrier: "顺丰干配",
    });
    expect(result.success).toBe(true);
  });

  it("defaults quantity to 1 when omitted", () => {
    const result = QuoteV2RequestSchema.safeParse({
      product_category: "牛栏网",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.quantity).toBe(1);
    }
  });

  it("defaults accessories to empty array when omitted", () => {
    const result = QuoteV2RequestSchema.safeParse({
      product_category: "牛栏网",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accessories).toEqual([]);
    }
  });

  it("rejects missing product_category", () => {
    const result = QuoteV2RequestSchema.safeParse({
      quantity: 100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative quantity", () => {
    const result = QuoteV2RequestSchema.safeParse({
      product_category: "牛栏网",
      quantity: -5,
    });
    expect(result.success).toBe(false);
  });
});

describe("QuoteV2ResponseSchema", () => {
  const matchedPayload = {
    status: "matched",
    product_category: "牛栏网",
    main_line: {
      product_category: "牛栏网",
      spec_summary:
        "牛栏网 | 上疏下密 | 2.5x2.0丝径 | 1.5m高 | 15.0m网宽 | 50.0m长",
      quantity: 100,
      unit: "卷",
      weight_kg: 32.5,
      tiers: [
        { label: "低", unit_price: 182.33, subtotal: 18232.5, total: 18232.5 },
        {
          label: "标准",
          unit_price: 190.61,
          subtotal: 19061.25,
          total: 19061.25,
        },
        { label: "高", unit_price: 198.9, subtotal: 19890.0, total: 19890.0 },
      ],
      status: "matched",
    },
    accessory_lines: [],
    freight: null,
    totals: { low: 18232.5, standard: 19061.25, high: 19890.0 },
    notes: [
      "已匹配规格: 牛栏网 | 上疏下密 | 2.5x2.0丝径 | 1.5m高 | 15.0m网宽 | 50.0m长",
    ],
    copyable_script:
      "【牛栏网报价单】\n\n产品: 牛栏网 | 上疏下密 | 2.5x2.0丝径 | 1.5m高 | 15.0m网宽 | 50.0m长",
  };

  it("validates a matched response", () => {
    const result = QuoteV2ResponseSchema.safeParse(matchedPayload);
    expect(result.success).toBe(true);
  });

  it("validates a no_match response", () => {
    const result = QuoteV2ResponseSchema.safeParse({
      status: "no_match",
      product_category: "石笼网",
      main_line: {
        product_category: "石笼网",
        spec_summary: "",
        quantity: 1,
        unit: "卷",
        tiers: [],
        status: "unavailable",
      },
      accessory_lines: [],
      totals: { low: 0, standard: 0, high: 0 },
      notes: ["未匹配到规格"],
      copyable_script: "",
    });
    expect(result.success).toBe(true);
  });

  it("validates a cost_pending response", () => {
    const result = QuoteV2ResponseSchema.safeParse({
      status: "cost_pending",
      product_category: "牛栏网",
      main_line: {
        product_category: "牛栏网",
        spec_summary: "牛栏网 2.5mm",
        quantity: 100,
        unit: "卷",
        weight_kg: 15.5,
        tiers: [],
        status: "unavailable",
      },
      accessory_lines: [],
      totals: { low: 0, standard: 0, high: 0 },
      notes: ["规格匹配成功", "该规格成本待维护"],
      copyable_script: "",
    });
    expect(result.success).toBe(true);
  });

  it("validates an unsupported_category response", () => {
    const result = QuoteV2ResponseSchema.safeParse({
      status: "unsupported_category",
      product_category: "石笼网",
      main_line: {
        product_category: "石笼网",
        spec_summary: "",
        quantity: 1,
        unit: "卷",
        tiers: [],
        status: "unavailable",
      },
      accessory_lines: [],
      totals: { low: 0, standard: 0, high: 0 },
      notes: ["暂不支持品类"],
      copyable_script: "【牛栏网报价 - 暂不支持品类】",
    });
    expect(result.success).toBe(true);
  });

  it("validates a too_many response", () => {
    const result = QuoteV2ResponseSchema.safeParse({
      status: "too_many",
      product_category: "牛栏网",
      main_line: {
        product_category: "牛栏网",
        spec_summary: "",
        quantity: 100,
        unit: "卷",
        weight_kg: null,
        tiers: [],
        status: "unavailable",
      },
      accessory_lines: [],
      totals: { low: 0, standard: 0, high: 0 },
      notes: ["找到 3 条匹配记录，请细化筛选条件"],
      copyable_script: "",
    });
    expect(result.success).toBe(true);
  });

  it("handles weight_kg being null (unavailable main_line)", () => {
    const result = QuoteV2ResponseSchema.safeParse({
      status: "no_match",
      product_category: "牛栏网",
      main_line: {
        product_category: "牛栏网",
        spec_summary: "",
        quantity: 1,
        unit: "卷",
        weight_kg: null,
        tiers: [],
        status: "unavailable",
      },
      accessory_lines: [],
      totals: { low: 0, standard: 0, high: 0 },
      notes: [],
      copyable_script: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.main_line.weight_kg).toBeNull();
    }
  });

  it("validates response with accessories and freight (real backend format)", () => {
    const result = QuoteV2ResponseSchema.safeParse({
      ...matchedPayload,
      accessory_lines: [
        {
          product_category: "立柱",
          spec_summary: "立柱 | 直边 | 1.8m | 10支/捆",
          quantity: 50,
          unit: "个",
          total: 9000.0,
          status: "matched",
        },
      ],
      freight: {
        province: "四川",
        chosen: { carrier: "顺丰干配", amount: 4980.0 },
        options: [
          { carrier: "顺丰干配", amount: 4980.0 },
          { carrier: "顺丰零担", amount: 6500.0 },
        ],
        status: "matched",
      },
      totals: { low: 23212.5, standard: 24041.25, high: 24870.0 },
    });
    expect(result.success).toBe(true);
  });

  it("copies freight fields as defined in real backend (chosen can be null)", () => {
    const result = QuoteV2ResponseSchema.safeParse({
      ...matchedPayload,
      freight: {
        province: "广东省",
        chosen: null,
        options: [],
        status: "freight_missing",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.freight).not.toBeNull();
      expect(result.data.freight!.chosen).toBeNull();
    }
  });

  it("ensures copyable_script is a string", () => {
    const result = QuoteV2ResponseSchema.safeParse({
      ...matchedPayload,
      copyable_script: undefined,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.copyable_script).toBe("string");
    }
  });

  it("defaults totals to zeros", () => {
    const result = QuoteV2ResponseSchema.safeParse({
      ...matchedPayload,
      totals: undefined,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totals.low).toBe(0);
      expect(result.data.totals.standard).toBe(0);
      expect(result.data.totals.high).toBe(0);
    }
  });
});

describe("TierItemSchema", () => {
  it("validates a tier item", () => {
    const result = TierItemSchema.safeParse({
      label: "标准",
      unit_price: 3.85,
      subtotal: 385,
      total: 385,
    });
    expect(result.success).toBe(true);
  });

  it("rejects tier with missing unit_price", () => {
    const result = TierItemSchema.safeParse({
      label: "标准",
      subtotal: 385,
      total: 385,
    });
    expect(result.success).toBe(false);
  });
});

describe("MainLineSchema", () => {
  it("validates a matched main line", () => {
    const result = MainLineSchema.safeParse({
      product_category: "牛栏网",
      spec_summary: "牛栏网 2.5mm",
      quantity: 100,
      unit: "卷",
      tiers: [{ label: "标准", unit_price: 3.85, subtotal: 385, total: 385 }],
      status: "matched",
    });
    expect(result.success).toBe(true);
  });

  it("validates an unavailable main line with empty tiers", () => {
    const result = MainLineSchema.safeParse({
      product_category: "石笼网",
      spec_summary: "",
      quantity: 1,
      unit: "卷",
      tiers: [],
      status: "unavailable",
    });
    expect(result.success).toBe(true);
  });
});

describe("FreightInfoSchema", () => {
  it("validates freight info with chosen option", () => {
    const result = FreightInfoSchema.safeParse({
      province: "广东省",
      chosen: { carrier: "德邦物流", amount: 350 },
      options: [{ carrier: "德邦物流", amount: 350 }],
      status: "freight_available",
    });
    expect(result.success).toBe(true);
  });

  it("validates freight info without chosen option", () => {
    const result = FreightInfoSchema.safeParse({
      province: "广东省",
      options: [],
      status: "freight_missing",
    });
    expect(result.success).toBe(true);
  });
});

describe("ProductSpecsOptionsSchema", () => {
  it("validates full product specs options (real backend format)", () => {
    const result = ProductSpecsOptionsSchema.safeParse({
      product_category: "牛栏网",
      options: {
        product_types: ["上疏下密", "环扣"],
        wire_diameters: ["2.0x1.8", "2.5x2.0"],
        heights: [1.5, 1.8],
        mesh_widths: [15.0],
        mesh_specs: [],
        roll_lengths: [50.0],
        bundle_sizes: [],
      },
      accessory_categories: ["立柱"],
    });
    expect(result.success).toBe(true);
  });

  it("validates minimal specs options", () => {
    const result = ProductSpecsOptionsSchema.safeParse({
      product_category: "牛栏网",
      options: {},
      accessory_categories: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing product_category", () => {
    const result = ProductSpecsOptionsSchema.safeParse({
      options: {},
      accessory_categories: [],
    });
    expect(result.success).toBe(false);
  });
});
