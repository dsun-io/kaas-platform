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
  "beneficiary_decl",
  "non_wood_packing",
  "weight_list",
  "quality_cert",
  "manufacturer_cert",
  "bl",
  "co",
  "insurance",
  "customs_declaration",
  "fumigation_cert",
  "saso_coc",
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
      // 基准在 git 中以 LF 存储；Windows（core.autocrlf=true）检出会变成 CRLF，
      // 而渲染器输出 LF —— 两侧不归一会让 18 类单证在 Windows 上全线假红，
      // 真实回归反而被换行噪音淹没。与 scripts/verify-trade-doc-fixtures.py 同口径。
      const normalize = (s: string) => s.replace(/\r\n/g, "\n");
      const actualNorm = normalize(actual);
      const expectedNorm = normalize(
        readFileSync(join(GOLDEN_HTML, `sample_${docType}.html`), "utf-8"),
      );
      if (actualNorm !== expectedNorm) {
        // 给出首个差异位置，方便定位（而不是只报"不相等"）
        let idx = 0;
        while (
          idx < Math.min(actualNorm.length, expectedNorm.length) &&
          actualNorm[idx] === expectedNorm[idx]
        )
          idx += 1;
        mismatches.push(
          `${docType}: 长度 ${actualNorm.length} vs 基准 ${expectedNorm.length}；` +
            `首个差异 @${idx} 实际=${JSON.stringify(actualNorm.slice(idx, idx + 40))} ` +
            `基准=${JSON.stringify(expectedNorm.slice(idx, idx + 40))}`,
        );
      }
    }
    expect(
      mismatches,
      `以下单证与基准不一致:\n${mismatches.join("\n")}`,
    ).toEqual([]);
  });
});

// ── 双币种金额块（A6-1）─────────────────────────────────────────────────

describe("双币种金额块（有 fx_rate 才渲染）", () => {
  const FX_DATA = JSON.parse(
    readFileSync(join(HERE, "..", "sample-data-fx.json"), "utf-8"),
  ) as { doc_types: string[]; base: Record<string, unknown> };

  it("PI/CI 双币种变体与基线逐字节一致（含四列行项 + 金额块）", () => {
    expect(FX_DATA.doc_types).toEqual(["pi", "ci"]);
    const normalize = (s: string) => s.replace(/\r\n/g, "\n");
    for (const docType of FX_DATA.doc_types) {
      const actual = normalize(renderTradeDoc(docType, FX_DATA.base));
      const expected = normalize(
        readFileSync(join(GOLDEN_HTML, `sample_${docType}_fx.html`), "utf-8"),
      );
      expect(actual, `${docType} 与双币种基线不一致`).toBe(expected);
    }
  });

  it("四列表头 + 汇率行 + 舍入/货物总值/运费/应付总额/定金尾款都在", () => {
    const html = renderTradeDoc("pi", FX_DATA.base);
    for (const label of [
      "Unit Price (CNY)",
      "Amount (CNY)",
      "Unit Price (USD)",
      "Amount (USD)",
      "Currency / Exchange Rate: 1 USD = 6.7029 CNY",
      "Rounding adjustment",
      "Total Goods Value",
      "Inland Freight to Delivery Address",
      "TOTAL AMOUNT PAYABLE",
      "Deposit (30%)",
      "Balance (70%)",
    ]) {
      expect(html, `缺少「${label}」`).toContain(label);
    }
    // 真实样例的换算口径：25.00 CNY → 3.7297 USD；10,000.00 CNY → 1,491.89 USD
    expect(html).toContain(">3.7297<");
    expect(html).toContain(">1,491.89<");
    // 旧单币种 TOTAL 行不应与金额块同时出现（价格列已由金额块表达）
    expect(html).not.toContain('<tr class="total">');
  });

  it("无 fx_rate 时旧输出不变：不出现双币种表格", () => {
    const legacy = renderTradeDoc("pi", payload.base);
    expect(legacy).not.toContain("fx-money");
    expect(legacy).not.toContain("Unit Price (CNY)");
    // 与 18 份基线中的 PI 完全一致（同一份单币种样例数据）
    expect(legacy.replace(/\r\n/g, "\n")).toBe(
      readFileSync(join(GOLDEN_HTML, "sample_pi.html"), "utf-8").replace(
        /\r\n/g,
        "\n",
      ),
    );
  });

  it("G7 收款账户结构化：beneficiary / 税号 / 账号 / 银行 / SWIFT 分行渲染", () => {
    const html = renderTradeDoc("pi", FX_DATA.base);
    for (const label of [
      "Beneficiary: ANPING LIANJIA WIRE MESH PRODUCTS CO., LTD.",
      "Beneficiary Address:",
      "Beneficiary Tax ID: 91131125MA0GA4242U",
      "Account No.: 13050171770800004556",
      "China Construction Bank Corporation, Hebei Anping Sub-branch",
      "SWIFT: PCBCCNBJHBX",
    ]) {
      expect(html, `缺少「${label}」`).toContain(label);
    }
  });

  it("显式覆盖优先于推导（order-level custom 可对齐客户底稿）", () => {
    const html = renderTradeDoc("pi", {
      ...FX_DATA.base,
      rounding_adjustment_cny: -2.54,
      rounding_adjustment_usd: -0.37,
      total_goods_value_cny: 18195.66,
      total_goods_value_usd: 2714.6,
      inland_freight_cny: 750,
      inland_freight_usd: 111.89,
      total_payable_cny: 18945.66,
      total_payable_usd: 2826.49,
      deposit_cny: 5683.7,
      deposit_usd: 847.95,
      balance_cny: 13261.96,
      balance_usd: 1978.54,
    });
    expect(html).toContain("CNY -2.54");
    expect(html).toContain("USD -0.37");
    expect(html).toContain("CNY 18,945.66");
    expect(html).toContain("USD 2,826.49");
    expect(html).toContain("Deposit (30%)");
    expect(html).toContain("CNY 5,683.70");
  });

  it("其它单证类型即便带 fx_rate 也不进入双币种（合同双语属 A6-2）", () => {
    const html = renderTradeDoc("contract", FX_DATA.base);
    expect(html).not.toContain("fx-money");
  });
});

// ── A6 剩余 P1（G7–G12）变体 ──────────────────────────────────────────────

describe("A6 剩余 P1：引用链 / 税号 / CI 双栏 / 合同双语 / PI P2", () => {
  const P1_DATA = JSON.parse(
    readFileSync(join(HERE, "..", "sample-data-a6p1.json"), "utf-8"),
  ) as {
    doc_types: string[];
    base: Record<string, unknown>;
    per_doc: Record<string, Record<string, unknown>>;
  };

  const dataOf = (docType: string) => ({
    ...P1_DATA.base,
    ...(P1_DATA.per_doc[docType] ?? {}),
  });
  const normalize = (s: string) => s.replace(/\r\n/g, "\n");

  it("三份 P1 变体（PI / CI / 合同双语）与基线逐字节一致", () => {
    const goldens: Record<string, string> = {
      pi: "sample_pi_a6p1.html",
      ci: "sample_ci_a6p1.html",
      contract: "sample_contract_bilingual.html",
    };
    for (const [docType, file] of Object.entries(goldens)) {
      const actual = normalize(renderTradeDoc(docType, dataOf(docType)));
      const expected = normalize(
        readFileSync(join(GOLDEN_HTML, file), "utf-8"),
      );
      expect(actual, `${docType} 与 P1 变体基线不一致`).toBe(expected);
    }
  });

  it("G8 引用链：PI 带报价/合同号、CI 带 PI 号、合同带报价/PI 号", () => {
    expect(renderTradeDoc("pi", dataOf("pi"))).toContain(
      "Ref. Quotation No.: LJ-Q-20260928-01",
    );
    expect(renderTradeDoc("pi", dataOf("pi"))).toContain(
      "Ref. Contract No.: LJ-SC-20261012-01",
    );
    expect(renderTradeDoc("ci", dataOf("ci"))).toContain(
      "Ref. Proforma Invoice No.: LJ-PI-20260929-01",
    );
    const contract = renderTradeDoc("contract", dataOf("contract"));
    expect(contract).toContain("Ref. Quotation No.: LJ-Q-20260928-01");
    expect(contract).toContain("Ref. Proforma Invoice No.: LJ-PI-20260929-01");
    // 附件清单（G8）渲染成 Annexes 行，而不是行项表
    expect(contract).toContain("Annexes forming an integral part of this contract");
    expect(contract).toContain("Proforma Invoice No. LJ-PI-20260929-01");
  });

  it("G9 税号/联系方式：seller/buyer 对象的 tax_id 与 tel 被渲染", () => {
    const html = renderTradeDoc("pi", dataOf("pi"));
    expect(html).toContain("Tax ID: 91131125MA0GA4242U");
    expect(html).toContain("Tel: +61 438 381 068");
  });

  it("G7 CI 收款账户区块：结构化 bank_info 才渲染", () => {
    const html = renderTradeDoc("ci", dataOf("ci"));
    for (const label of [
      "Bank Details for Remittance",
      "Beneficiary: ANPING LIANJIA WIRE MESH PRODUCTS CO., LTD.",
      "Beneficiary Tax ID: 91131125MA0GA4242U",
      "Account No.: 13050171770800004556",
      "SWIFT: PCBCCNBJHBX",
    ]) {
      expect(html).toContain(label);
    }
    // 旧数据（仅 bank/account/swift）不渲染该区块 ⇒ 18 份基线不变
    const legacy = renderTradeDoc("ci", payload.base);
    expect(legacy).not.toContain("Bank Details for Remittance");
  });

  it("G10 CI BILL TO / CONSIGNED TO 双栏：有对象才渲染", () => {
    const html = renderTradeDoc("ci", dataOf("ci"));
    expect(html).toContain("BILL TO");
    expect(html).toContain("CONSIGNED TO");
    expect(html).toContain("Jiangsu Juncheng Vehicle Industry Co., Ltd.");
    expect(renderTradeDoc("ci", payload.base)).not.toContain("BILL TO");
  });

  it("G11 合同双语条款：默认 12 条中英双语，custom.clauses 可覆盖", () => {
    const html = renderTradeDoc("contract", dataOf("contract"));
    expect(html.match(/class="bi-clause"/g)?.length).toBe(12);
    expect(html).toContain("1. 品质 / Quality");
    expect(html).toContain("12. 生效与附件 / Effectiveness &amp; Annexes");
    expect(html).toContain("customized wording"); // per_doc 里覆盖了 quality 的英文
    // 双语模式替代旧 4 条英文条款（不重复出现旧 label 区块）
    expect(html).not.toContain('<span class="lbl">Inspection</span>');
    // 不传 clauses ⇒ 旧 4 条英文条款原样输出（18 份基线路径）
    const legacy = renderTradeDoc("contract", payload.base);
    expect(legacy).toContain('<span class="lbl">Inspection</span>');
    expect(legacy).not.toContain("品质 / Quality");
  });

  it("G12 PI P2：有效期/包装/生产进度/拼柜方/签署人（有值才显示）", () => {
    const html = renderTradeDoc("pi", dataOf("pi"));
    for (const label of [
      "Valid Until: 14-Oct-2026",
      "Packing:",
      "Production Updates:",
      "Third-party Consolidator:",
      "Signed for the Seller: Sun Jiaze",
    ]) {
      expect(html).toContain(label);
    }
    // 老 PI 数据（共享 base 带 valid_until、但没有 P2 字段）不显示有效期 ⇒ 基线不变
    expect(renderTradeDoc("pi", payload.base)).not.toContain("Valid Until");
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

// ── 图片字段（2026-10-11 新增：公章 + 产品照片）────────────────────────

describe("图片字段（company_stamp / product_photos）", () => {
  /** 最小合法 data URI（只验通道，不验图像内容） */
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

  it("公章与产品照片渲染为 <img>，说明文字随图出现", () => {
    const html = renderTradeDoc("pi", {
      ...MINIMAL_DATA,
      company_stamp: PNG,
      product_photos: [
        {
          image: "https://example.com/chain-link.jpg",
          caption: "Item 1 — Chain Link Fence",
        },
        { image: PNG, caption: "Item 2 — Razor Wire" },
      ],
    });
    expect(html).toContain('class="stamp-img"');
    expect(html).toContain(`src="${PNG}"`);
    expect(html).toContain('class="photos"');
    expect(html).toContain("https://example.com/chain-link.jpg");
    expect(html).toContain("Item 1 — Chain Link Fence");
    expect(html).toContain("Item 2 — Razor Wire");
  });

  it("非法图片源被丢弃，且不留下空壳容器", () => {
    const html = renderTradeDoc("pi", {
      ...MINIMAL_DATA,
      company_stamp: "javascript:alert(1)",
      product_photos: [{ image: "  ", caption: "x" }, { image: "/local.png" }],
    });
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain("stamp-img");
    // 一张有效图片都没有 → 整个图片区块不出现（不会印出一个空框）
    expect(html).not.toContain('class="photos"');
  });

  it("照片说明文字被转义（图片字段不是 XSS 后门）", () => {
    const html = renderTradeDoc("pi", {
      ...MINIMAL_DATA,
      company_stamp: PNG,
      product_photos: [
        { image: "https://example.com/a.jpg", caption: "<script>alert(1)</script>" },
      ],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("不传图片时 PI 版面无任何图片残留（18 份基线继续有效）", () => {
    const html = renderTradeDoc("pi", { ...payload.base });
    expect(html).not.toContain('class="photos"');
    expect(html).not.toContain("stamp-img");
  });

  it("字段定义已登记（供动态表单 / AI 填充识别）", () => {
    const fields = getTemplateFields("pi") as Record<
      string,
      { type?: string; required?: boolean }
    >;
    expect(fields.company_stamp?.type).toBe("image");
    expect(fields.product_photos?.type).toBe("image_list");
    // 两个字段都是可选：PI 不带图也是合法单据，不能因此拦住签发
    expect(fields.company_stamp?.required).toBe(false);
    expect(fields.product_photos?.required).toBe(false);
  });
});

// ── 买方回签栏（可选，默认不印）────────────────────────────────────────

describe("买方回签栏（buyer_confirmation）", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

  it("true 时用买方公司名生成回签栏", () => {
    const html = renderTradeDoc("pi", {
      ...MINIMAL_DATA,
      buyer_confirmation: true,
    });
    expect(html).toContain("Buyer's Confirmation");
    expect(html).toContain("Accepted by Australian Rural Fencing Pty Ltd");
  });

  it("两侧签章模块等高：卖方有公章时，买方留出同一高度的空图章位", () => {
    // 两个模块都必须是「图章位 + 分隔线 + 标题 + 说明行」四件套，且图章位同高，
    // 否则左右两个签章框一高一低，版面不对称（审单场景很扎眼）。
    const html = renderTradeDoc("pi", {
      ...MINIMAL_DATA,
      company_stamp: PNG,
      buyer_confirmation: true,
    });
    const slots = html.match(/class="stamp-img"/g) ?? [];
    expect(slots.length).toBe(2); // 卖方公章位 + 买方空格位
  });

  it("卖方未放公章时，买方侧也不留空位（两侧仍然等高）", () => {
    const html = renderTradeDoc("pi", {
      ...MINIMAL_DATA,
      buyer_confirmation: true,
    });
    expect(html).toContain("Buyer's Confirmation");
    expect(html).not.toContain("stamp-img");
  });

  it("可填自定义抬头；说明文字被转义", () => {
    const html = renderTradeDoc("pi", {
      ...MINIMAL_DATA,
      buyer_confirmation: "ACME TRADING LLC <script>alert(1)</script>",
    });
    expect(html).toContain("Accepted by ACME TRADING LLC");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("不给值 / 给假值时不出该栏（默认口径：PI 是卖方单方文件）", () => {
    for (const value of [undefined, false, "", 0]) {
      const html = renderTradeDoc("pi", {
        ...MINIMAL_DATA,
        buyer_confirmation: value,
      });
      expect(html).not.toContain("Buyer's Confirmation");
    }
  });

  it("字段定义已登记且为可选", () => {
    const fields = getTemplateFields("pi") as Record<
      string,
      { type?: string; required?: boolean }
    >;
    expect(fields.buyer_confirmation?.type).toBe("boolean");
    expect(fields.buyer_confirmation?.required).toBe(false);
  });
});

// ── 多行字段（备注逐点换行）────────────────────────────────────────────

describe("多行字段（remarks / notes）", () => {
  it("remarks 的换行保留为 <br>（1) 2) 3) 逐点换行）", () => {
    const html = renderTradeDoc("pi", {
      ...MINIMAL_DATA,
      remarks: "1) first line\n2) second line\r\n3) third line",
    });
    expect(html).toContain(
      "1) first line<br>2) second line<br>3) third line",
    );
  });

  it("换行是唯一例外：其余照样转义（不是注入后门）", () => {
    const html = renderTradeDoc("pi", {
      ...MINIMAL_DATA,
      remarks: "<script>alert(1)</script>\nplain",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;<br>plain");
  });

  it("非多行字段的换行仍按 HTML 折叠（不改既有口径）", () => {
    const html = renderTradeDoc("pi", {
      ...MINIMAL_DATA,
      shipping_marks: "LINE1\nLINE2",
    });
    expect(html).not.toContain("LINE1<br>LINE2");
  });
});

// ── A10 P1：受益人声明 / 符合性认证（申请信息）────────────────────────────

describe("A10 P1 扩展模板（beneficiary_decl / saso_coc）", () => {
  const A10_DATA = JSON.parse(
    readFileSync(join(HERE, "..", "sample-data-a10.json"), "utf-8"),
  ) as {
    doc_types: string[];
    base: Record<string, unknown>;
    per_doc: Record<string, Record<string, unknown>>;
  };
  const dataOf = (docType: string) => ({
    ...A10_DATA.base,
    ...(A10_DATA.per_doc[docType] ?? {}),
  });
  const normalize = (html: string) => html.replace(/\r\n/g, "\n");

  it("两份新增基线逐字节一致（旧 18 类由上面的主基线钉住）", () => {
    const mismatches: string[] = [];
    for (const docType of A10_DATA.doc_types) {
      const actual = normalize(renderTradeDoc(docType, dataOf(docType)));
      const expected = normalize(
        readFileSync(join(GOLDEN_HTML, `sample_${docType}.html`), "utf-8"),
      );
      if (actual !== expected) mismatches.push(docType);
    }
    expect(mismatches).toEqual([]);
  });

  it("beneficiary_decl：默认声明正文可被 declaration_text 覆盖，换行保留", () => {
    const base = dataOf("beneficiary_decl");
    const fallback = renderTradeDoc("beneficiary_decl", base);
    expect(fallback).toContain("We, the beneficiary, hereby declare");
    expect(fallback).toContain("Declaration Type");
    expect(fallback).toContain("shipment");

    const custom = renderTradeDoc("beneficiary_decl", {
      ...base,
      declaration_text: "Line one\nLine two",
    });
    expect(custom).toContain("Line one<br>Line two");
    // 自定义正文完整替换默认句，不是"默认 + 追加"
    expect(custom).not.toContain("We, the beneficiary, hereby declare");
  });

  it("saso_coc：证书号/标准/签发机构缺失时留空，不伪造默认值", () => {
    const minimal = renderTradeDoc("saso_coc", {
      ...A10_DATA.base,
      destination_country: "[DESTINATION COUNTRY]",
    });
    // 版面标签必须在
    for (const label of [
      "Certificate No.",
      "Standard / Regulation",
      "Test Report No.",
      "Issuing Authority",
      "Valid Until",
      "Batch No.",
    ]) {
      expect(minimal, `缺少「${label}」`).toContain(label);
    }
    // 但值不许预置：未给就不出现认证机构/标准，也不残留占位符
    expect(minimal).not.toContain("SASO");
    expect(minimal).not.toContain("SGS");
    expect(minimal).not.toContain("Intertek");
    expect(minimal).not.toMatch(/\$(cert_no|standard_applied|issuing_authority)/);
  });

  it("saso_coc：给了证书类字段时按证书版式渲染", () => {
    const html = renderTradeDoc("saso_coc", dataOf("saso_coc"));
    for (const label of [
      "Certificate No.",
      "Date",
      "Applicant",
      "Consignee",
      "Destination Country",
      "Country of Origin",
      "Standard / Regulation",
      "Test Report No.",
      "Issuing Authority",
      "Valid Until",
      "Batch No.",
      "Issue Date",
    ]) {
      expect(html, `缺少「${label}」`).toContain(label);
    }
    expect(html).toContain("[CERTIFICATION BODY]");
    expect(html).toContain("this sheet is not the certificate itself");
  });
});
