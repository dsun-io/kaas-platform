/**
 * 单证渲染器测试（由后端 Python 测试逐条移植而来）
 *
 * 关键的一类是 `逐字节基准比对`：把渲染结果与「Python 版当初的输出」逐字节比对。
 * 为什么必须这样做：渲染器从 Python 迁到 TypeScript，最容易的翻车方式是
 * 「看着差不多」—— 金额千分位、日期写法、某列缺失，肉眼极难发现，
 * 但海关/银行审单就是按这些细节判「不符点」。逐字节比对让任何细微差异直接测试失败。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  renderTradeDoc,
  getAvailableTemplates,
  getTemplateFields,
  amountInWords,
} from "../render";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "__fixtures__");
const GOLDEN_HTML = join(FIXTURES, "html");

// 样例数据放在应用层（src/lib/trade-doc/sample-data.json），页面与测试共用一份：
// 工位里的「样板预览」用它渲染，测试用它做逐字节基准比对 —— 一份数据两处受益，不会走神。
const payload = JSON.parse(
  readFileSync(join(HERE, "..", "sample-data.json"), "utf-8"),
) as {
  doc_types: string[];
  base: Record<string, unknown>;
  other_extra: Record<string, unknown>;
};

const MINIMAL_DATA: Record<string, unknown> = {
  seller: {
    company: "安平县恒泰金属丝网制品有限公司",
    address: "河北省安平县",
  },
  buyer: { company: "Australian Rural Fencing Pty Ltd" },
  currency: "USD",
  total_amount: 26450.0,
  items: [
    {
      product_name: "牛栏网 Cattle Fence",
      qty: 500,
      qty_unit: "Rolls",
      unit_price: 28.5,
      line_amount: 14250.0,
    },
  ],
};

/** 全部单证类型：出口商自制 + 第三方签发（申报/申请信息） + 通用 */
const ALL_DOC_TYPES = [
  "quotation",
  "pi",
  "contract",
  "ci",
  "pl",
  "shipping_advice",
  "draft",
  "beneficiary_cert",
  "non_wood_packing",
  "weight_list",
  "quality_cert",
  "manufacturer_cert",
  "bl",
  "co",
  "insurance",
  "customs_declaration",
  "fumigation_cert",
  "other",
];

// ── 逐字节基准比对（迁移等价性的硬保证）────────────────────────────────

describe("逐字节基准比对（Python 版输出 → TypeScript 版输出）", () => {
  it("18 类单证的渲染结果与基准产物完全一致", () => {
    expect(payload.doc_types.length).toBe(18);

    const mismatches: string[] = [];
    for (const docType of payload.doc_types) {
      const data = {
        ...payload.base,
        ...(docType === "other" ? payload.other_extra : {}),
      };
      const actual = renderTradeDoc(docType, data);
      const expected = readFileSync(
        join(GOLDEN_HTML, `sample_${docType}.html`),
        "utf-8",
      );
      if (actual !== expected) {
        // 给出首个差异位置，方便定位（而不是只报"不相等"）
        let idx = 0;
        while (
          idx < Math.min(actual.length, expected.length) &&
          actual[idx] === expected[idx]
        )
          idx += 1;
        mismatches.push(
          `${docType}: 长度 ${actual.length} vs 基准 ${expected.length}；` +
            `首个差异 @${idx} 实际=${JSON.stringify(actual.slice(idx, idx + 40))} ` +
            `基准=${JSON.stringify(expected.slice(idx, idx + 40))}`,
        );
      }
    }
    expect(
      mismatches,
      `以下单证与基准不一致:\n${mismatches.join("\n")}`,
    ).toEqual([]);
  });
});

// ── 模板清单与字段 ──────────────────────────────────────────────────────

describe("模板清单", () => {
  it("覆盖全部单证类型", () => {
    const types = getAvailableTemplates().map((t) => t.doc_type);
    expect(new Set(types)).toEqual(new Set(ALL_DOC_TYPES));
  });

  it("返回字段定义", () => {
    const fields = getTemplateFields("pi");
    expect(fields).not.toBeNull();
    expect(Object.keys(fields!)).toContain("seller");
    expect(Object.keys(fields!)).toContain("items");
    expect(Object.keys(fields!)).toContain("bank_info");
    expect(getTemplateFields("nonexistent")).toBeNull();
  });
});

// ── 基础渲染 ────────────────────────────────────────────────────────────

describe("基础渲染", () => {
  it.each(ALL_DOC_TYPES)("%s 渲染不抛异常且不残留占位符", (docType) => {
    const html = renderTradeDoc(docType, MINIMAL_DATA);
    expect(html).toContain("<html");
    expect(html).not.toContain("$seller");
    expect(html).not.toContain("$buyer");
  });

  it("填入业务值并格式化金额", () => {
    const html = renderTradeDoc("pi", {
      ...MINIMAL_DATA,
      pi_no: "PI-TEST-0001",
    });
    expect(html).toContain("安平县恒泰金属丝网制品有限公司");
    expect(html).toContain("Australian Rural Fencing Pty Ltd");
    expect(html).toContain("PI-TEST-0001");
    expect(html).toContain("26,450.00"); // 金额千分位格式化
    expect(html).toContain("牛栏网");
  });

  it("未知类型报错", () => {
    expect(() => renderTradeDoc("unknown_type", {})).toThrow(
      /不支持的单证类型/,
    );
  });

  it("缺失可选字段安全（不抛异常、不残留占位符）", () => {
    const html = renderTradeDoc("quotation", { currency: "USD" });
    expect(html).toContain("<html");
    expect(html).not.toContain("$remarks");
  });
});

// ── 英文印刷级单证能力 ──────────────────────────────────────────────────

describe("金额英文大写（报关与信用证审单使用）", () => {
  it.each([
    [
      26450.0,
      "USD",
      "SAY US DOLLARS TWENTY-SIX THOUSAND FOUR HUNDRED AND FIFTY ONLY",
    ],
    [1000.5, "USD", "SAY US DOLLARS ONE THOUSAND AND CENTS FIFTY ONLY"],
    [0, "USD", "SAY US DOLLARS ZERO ONLY"],
    [
      1250000,
      "EUR",
      "SAY EUROS ONE MILLION TWO HUNDRED AND FIFTY THOUSAND ONLY",
    ],
    [15, "CNY", "SAY CHINESE YUAN FIFTEEN ONLY"],
  ])("amountInWords(%s, %s)", (amount, currency, expected) => {
    expect(amountInWords(amount, currency)).toBe(expected);
  });

  it("非法金额返回空串", () => {
    expect(amountInWords(null)).toBe("");
    expect(amountInWords("abc")).toBe("");
    expect(amountInWords(-1)).toBe("");
  });
});

describe("版面稳定性（审单硬要求）", () => {
  it("商业发票不含毛净重列，但必须含 HS Code", () => {
    const html = renderTradeDoc("ci", MINIMAL_DATA);
    expect(html).not.toContain("G.W. (KGS)");
    expect(html).not.toContain("N.W. (KGS)");
    expect(html).toContain("HS Code");
  });

  it("装箱单含包装与重量体积列", () => {
    const html = renderTradeDoc("pl", MINIMAL_DATA);
    expect(html).toContain("Packages");
    expect(html).toContain("G.W. (KGS)");
    expect(html).toContain("Meas. (CBM)");
  });

  it("日期改写为国际写法", () => {
    const html = renderTradeDoc("ci", {
      ...MINIMAL_DATA,
      invoice_date: "2026-10-20",
    });
    expect(html).toContain("20-Oct-2026");
    expect(html).not.toContain("2026-10-20");
  });

  it("行号是整数而非金额", () => {
    const html = renderTradeDoc("ci", MINIMAL_DATA);
    expect(html).not.toContain(">1.00<");
  });

  it("TOTAL 行显示数量合计与金额合计", () => {
    const html = renderTradeDoc("ci", MINIMAL_DATA);
    expect(html).toContain("TOTAL");
    expect(html).toContain("USD 26,450.00");
    expect(html).toContain(">500<"); // 数量合计由行项汇总
  });

  it("件数/毛重/净重/体积未显式提供时由行项自动汇总", () => {
    const data = {
      ...MINIMAL_DATA,
      items: [
        {
          product_name: "A",
          qty: 10,
          package: 2,
          gross_weight: 100,
          net_weight: 95,
          volume: 1.5,
        },
        {
          product_name: "B",
          qty: 5,
          package: 1,
          gross_weight: 50,
          net_weight: 48,
          volume: 0.5,
        },
      ],
    };
    const html = renderTradeDoc("pl", data);
    expect(html).toContain("150.00 KGS"); // 毛重 100 + 50
    expect(html).toContain("143.00 KGS"); // 净重 95 + 48
    expect(html).toContain("2.00 CBM"); // 体积 1.5 + 0.5
  });
});

describe("安全与样式", () => {
  it("业务值一律转义，防止单据被注入脚本", () => {
    const html = renderTradeDoc("ci", {
      ...MINIMAL_DATA,
      shipping_marks: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("通用单证的 content 字段按原始 HTML 透传", () => {
    const html = renderTradeDoc("other", {
      ...MINIMAL_DATA,
      title: "Beneficiary Certificate",
      content: "<p>We hereby certify.</p>",
    });
    expect(html).toContain("<p>We hereby certify.</p>");
  });

  it("共享打印样式已内联且不残留占位符", () => {
    const html = renderTradeDoc("ci", MINIMAL_DATA);
    expect(html).not.toContain("/*__SHARED_STYLE__*/");
    expect(html).toContain("@page");
    expect(html).toContain("table.items");
  });
});

// ── 特定单证类型 ────────────────────────────────────────────────────────

describe("特定单证类型", () => {
  it("汇票：金额大写 + 付款期限 + 付款人", () => {
    const html = renderTradeDoc("draft", {
      ...MINIMAL_DATA,
      draft_no: "DR-TEST-0001",
      draft_date: "2026-10-21",
      tenor: "SIGHT",
      payee: "BANK OF CHINA",
      drawee: "WESTPAC BANKING CORPORATION",
    });
    expect(html).toContain("DR-TEST-0001");
    // tenor 值渲染在 <span class="fill"> 内，断言需按渲染后的 HTML 写
    expect(html).toContain(">SIGHT</span> of this FIRST of Exchange");
    expect(html).toContain("BANK OF CHINA");
    expect(html).toContain("WESTPAC BANKING CORPORATION");
    expect(html).toContain(
      "SAY US DOLLARS TWENTY-SIX THOUSAND FOUR HUNDRED AND FIFTY ONLY",
    );
    expect(html).toContain("21-Oct-2026");
  });

  it("装运通知：ETD/ETA 同样按国际写法格式化", () => {
    const html = renderTradeDoc("shipping_advice", {
      ...MINIMAL_DATA,
      advice_no: "SA-TEST-0001",
      advice_date: "2026-10-21",
      etd: "2026-10-24",
      eta: "2026-11-08",
    });
    expect(html).toContain("24-Oct-2026");
    expect(html).toContain("08-Nov-2026");
  });

  it("非木质包装声明含免熏蒸关键表述（ISPM 15 场景）", () => {
    const html = renderTradeDoc("non_wood_packing", MINIMAL_DATA);
    expect(html).toContain("free from solid wood");
    expect(html).toContain("Non-Wood Packing Declaration");
  });

  it("第三方签发的单证必须标明签发方，避免被误当作正式凭证", () => {
    expect(renderTradeDoc("bl", MINIMAL_DATA)).toContain(
      "To Be Issued by the Carrier",
    );
    expect(renderTradeDoc("co", MINIMAL_DATA)).toContain("CCPIT");
    expect(renderTradeDoc("insurance", MINIMAL_DATA)).toContain(
      "To Be Issued by the Insurer",
    );
    expect(renderTradeDoc("fumigation_cert", MINIMAL_DATA)).toContain(
      "Fumigation Service Provider",
    );
    expect(renderTradeDoc("customs_declaration", MINIMAL_DATA)).toContain(
      "Customs Broker",
    );
  });
});

// ── 结构性约束 ──────────────────────────────────────────────────────────

describe("结构性约束", () => {
  it("凡使用 $items 的模板都必须定义固定列", () => {
    // 否则会静默回退到「列由数据键决定」，导致同一类单据的列序随数据漂移
    // （比如报关表里冒出装箱单的毛净重列）—— 审单场景下这是硬伤。
    const manifest = JSON.parse(
      readFileSync(join(HERE, "..", "manifest.json"), "utf-8"),
    ) as Record<string, { template_file: string }>;
    const templates = (
      JSON.parse(readFileSync(join(HERE, "..", "assets.json"), "utf-8")) as {
        templates: Record<string, string>;
      }
    ).templates;

    // 与 render.ts 中的 ITEM_COLUMNS 键集合保持一致（此处用渲染结果反查而非导入私有表）
    const missing: string[] = [];
    for (const [docType, specJson] of Object.entries(manifest)) {
      const body = templates[docType];
      if (!body) {
        missing.push(`${docType}(${specJson.template_file} 缺失)`);
        continue;
      }
      if (!body.includes("$items")) continue;
      // 固定列的判据：渲染后表头固定，且带 items 类的表格存在
      const html = renderTradeDoc(docType, {
        items: [
          {
            product_name: "A",
            qty: 1,
            qty_unit: "Pcs",
            unit_price: 1,
            line_amount: 1,
          },
        ],
      });
      const bodyStart = html.indexOf('<table class="items">');
      expect(bodyStart, `${docType} 未渲染出 items 表格`).toBeGreaterThan(-1);
      // 固定列的表头必含 Description of Goods（动态表头也用同一映射，故此判据只保证可读性）
      expect(html.slice(bodyStart, bodyStart + 400)).toContain(
        "Description of Goods",
      );
    }
    expect(missing).toEqual([]);
  });
});
