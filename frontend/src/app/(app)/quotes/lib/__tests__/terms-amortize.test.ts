import { describe, expect, it } from "vitest";

import type { ExportTermsTemplate } from "@contracts/export-quote";
import { buildTermsPerLine, isPerShipment, type BuiltTerms } from "../terms-amortize";

function template(): ExportTermsTemplate {
  return {
    base: "EXW",
    quote_as: "CIF",
    weight_field: "weight_per_piece_kg",
    items: {
      inland_freight: { name: "内陆运费", name_en: "Inland Freight", mode: "per_shipment", unit_hint: "", note: "", value: null },
      ocean_freight: { name: "海运费", name_en: "Ocean Freight", mode: "per_weight_ton", unit_hint: "", note: "", value: null },
      insurance: { name: "保险", name_en: "Insurance", mode: "insurance_of_cif", unit_hint: "", note: "", value: null },
    },
    ladder: [
      { code: "EXW", label: "出厂价", label_en: "EXW", items: [] },
      { code: "FOB", label: "FOB", label_en: "FOB", items: ["inland_freight"] },
      { code: "CIF", label: "CIF", label_en: "CIF", items: ["ocean_freight", "insurance"] },
    ],
  };
}

/** 取某行某个费用项的金额（测试内小工具，避免到处写非空断言）。 */
function fee(row: BuiltTerms, key: string): number {
  const items = row.items as Record<string, { value: number }>;
  return items[key]!.value;
}

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
    expect(amortized).toEqual(["inland_freight"]);
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
