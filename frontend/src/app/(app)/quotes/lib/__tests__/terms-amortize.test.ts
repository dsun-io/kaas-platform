import { describe, expect, it } from "vitest";

import type { ExportTermsTemplate } from "@contracts/export-quote";
import { buildTermsPerLine, isPerShipment, type BuiltTerms } from "../terms-amortize";

function template(): ExportTermsTemplate {
  return {
    base: "EXW",
    quote_as: "CIF",
    weight_field: "weight_per_piece_kg",
    items: {
      inland_freight: { name: "内陆运费", name_en: "Inland Freight", mode: "per_shipment", currency: "CNY", unit_hint: "", note: "", value: null },
      ocean_freight: { name: "海运费", name_en: "Ocean Freight", mode: "per_weight_ton", currency: "CNY", unit_hint: "", note: "", value: null },
      insurance: { name: "保险", name_en: "Insurance", mode: "insurance_of_cif", currency: "CNY", unit_hint: "", note: "", value: null },
      // DAP / DDP 两档新增的费用项：都是 per_shipment（整批一次），
      // 所以它们与内陆运费同属需要按件数分摊的一类。
      destination_charges: { name: "目的港费用及送货到门", name_en: "Destination charges & delivery to door", mode: "per_shipment", currency: "CNY", unit_hint: "元 / 整批", note: "", value: null },
      import_taxes: { name: "进口关税及税费", name_en: "Import duties & taxes", mode: "per_shipment", currency: "CNY", unit_hint: "元 / 整批", note: "", value: null },
    },
    ladder: [
      { code: "EXW", label: "出厂价", label_en: "Ex Works", items: [] },
      { code: "FOB", label: "FOB", label_en: "Free On Board", items: ["inland_freight"] },
      { code: "CIF", label: "CIF", label_en: "Cost, Insurance and Freight", items: ["ocean_freight", "insurance"] },
      { code: "DAP", label: "到门价（目的地交货）", label_en: "Delivered at Place", items: ["destination_charges"] },
      { code: "DDP", label: "完税到门价（含进口税费）", label_en: "Delivered Duty Paid", items: ["import_taxes"] },
    ],
  };
}

/** 取某行某个费用项的金额（测试内小工具，避免到处写非空断言）。 */
function fee(row: BuiltTerms, key: string): number {
  const items = row.items as Record<string, { value: number }>;
  return items[key]!.value;
}

describe("整单保险按货值分摊", () => {
  it("formula=insurance_of_exw 时用前端算好的每行美元金额；没给就先按 0", () => {
    const t = template();
    t.items.insurance = {
      ...t.items.insurance!,
      mode: "per_shipment",
      formula: "insurance_of_exw",
      currency: "USD",
    };
    const first = buildTermsPerLine(t, {}, [10, 30], "CIF");
    expect(fee(first.terms[0]!, "insurance")).toBe(0);
    expect(fee(first.terms[1]!, "insurance")).toBe(0);

    const second = buildTermsPerLine(
      t,
      {},
      [10, 30],
      "CIF",
      { insurance_of_exw: [15, 0] },
    );
    expect(fee(second.terms[0]!, "insurance")).toBe(15);
    expect(fee(second.terms[1]!, "insurance")).toBe(0);
  });
});

describe("整批费用按件数比例分摊", () => {
  it("per_shipment 按件数比例分摊；线性口径的项原样下发", () => {
    // 两行：10 卷 + 30 卷 → 分摊比例 1:3
    const { terms, amortized } = buildTermsPerLine(
      template(),
      { inland_freight: 1000, ocean_freight: 200, insurance: 0.003 },
      [10, 30],
    );
    expect(fee(terms[0]!, "inland_freight")).toBeCloseTo(250, 10);
    expect(fee(terms[1]!, "inland_freight")).toBeCloseTo(750, 10);
    // 随重量 / 按比例的项是"整单口径"，逐行累加本来就等价，**不动**
    expect(fee(terms[0]!, "ocean_freight")).toBe(200);
    expect(fee(terms[1]!, "insurance")).toBe(0.003);
    // 所有 per_shipment 项都会被记入（含没填金额的项），
    // 因为分摊是按 mode 判定的，不看这一项这次有没有填数字。
    expect(amortized).toEqual([
      "inland_freight",
      "destination_charges",
      "import_taxes",
    ]);
  });

  it("摊到单卷后每一行的每卷分摊完全相同（这是选比例法而非平均分的理由）", () => {
    const shares = [10, 30, 60];
    const { terms } = buildTermsPerLine(template(), { inland_freight: 1000 }, shares);
    // 引擎会 value ÷ 本行件数 摊到单卷 → 应恒等于 总额 ÷ 总件数
    const perRoll = terms.map((t, i) => fee(t, "inland_freight") / (shares[i] ?? 1));
    for (const v of perRoll) expect(v).toBeCloseTo(10, 10); // 1000 / 100 卷
  });

  it("分摊之和恒等于用户填写的整批金额（不丢不多）", () => {
    const { terms } = buildTermsPerLine(
      template(),
      { inland_freight: 900 },
      [7, 3, 5],
    );
    const sum = terms.reduce((acc, t) => acc + fee(t, "inland_freight"), 0);
    expect(sum).toBeCloseTo(900, 10);
  });

  it("单行时不分摊（避免 1 行也出现浮点尾巴）", () => {
    const { terms, amortized } = buildTermsPerLine(
      template(),
      { inland_freight: 1000 },
      [5],
    );
    expect(fee(terms[0]!, "inland_freight")).toBe(1000);
    expect(amortized).toEqual([]);
  });

  it("件数还都没填（总和为 0）时退化为平均分摊，金额不被吞掉", () => {
    const { terms } = buildTermsPerLine(template(), { inland_freight: 1000 }, [0, 0]);
    const sum = terms.reduce((acc, t) => acc + fee(t, "inland_freight"), 0);
    expect(sum).toBeCloseTo(1000, 10);
  });

  it("未填的费用项按 0 下发（引擎按 0 计，不会静默沿用上一次的值）", () => {
    const { terms } = buildTermsPerLine(template(), {}, [1, 1]);
    expect(fee(terms[0]!, "inland_freight")).toBe(0);
    expect(fee(terms[0]!, "ocean_freight")).toBe(0);
  });

  it("分摊判定只看 mode（不按费用项名字猜）", () => {
    expect(isPerShipment({ mode: "per_shipment" })).toBe(true);
    expect(isPerShipment({ mode: "per_weight_ton" })).toBe(false);
  });
});

describe("DAP / DDP：新增两档的费用项同样按件数分摊", () => {
  it("目的港费用与进口税费都是 per_shipment → 按件数比例分摊", () => {
    // 两行：10 卷 + 30 卷 → 分摊比例 1:3
    const { terms, amortized } = buildTermsPerLine(
      template(),
      { destination_charges: 1500, import_taxes: 800 },
      [10, 30],
    );
    expect(fee(terms[0]!, "destination_charges")).toBeCloseTo(375, 10);
    expect(fee(terms[1]!, "destination_charges")).toBeCloseTo(1125, 10);
    expect(fee(terms[0]!, "import_taxes")).toBeCloseTo(200, 10);
    expect(fee(terms[1]!, "import_taxes")).toBeCloseTo(600, 10);
    // 所有 per_shipment 项都会被记入（含金额为 0 的内陆运费），
    // 界面据此提示"整批费用已按件数分摊"。
    expect(amortized).toEqual([
      "inland_freight",
      "destination_charges",
      "import_taxes",
    ]);
  });

  it("DAP 只引用目的港费用、DDP 只引用进口税费（逐档累加）", () => {
    const t = template();
    const rungs = new Map(t.ladder.map((r) => [r.code, r.items]));
    expect(rungs.get("DAP")).toEqual(["destination_charges"]);
    expect(rungs.get("DDP")).toEqual(["import_taxes"]);
    // 下发时把完整阶梯原样带给引擎（引擎要按它逐档累加）
    const { terms } = buildTermsPerLine(t, { import_taxes: 800 }, [5, 5]);
    expect(terms[0]!.ladder.map((r) => r.code)).toEqual([
      "EXW",
      "FOB",
      "CIF",
      "DAP",
      "DDP",
    ]);
  });

  it("整批金额摊分之和不变（DDP 比 DAP 多出的正是进口税费）", () => {
    const { terms } = buildTermsPerLine(
      template(),
      { destination_charges: 1500, import_taxes: 800 },
      [7, 3],
    );
    const sum = (key: string) =>
      terms.reduce((acc, t) => acc + fee(t, key), 0);
    expect(sum("destination_charges")).toBeCloseTo(1500, 10);
    expect(sum("import_taxes")).toBeCloseTo(800, 10);
  });
});
