import { describe, expect, it } from "vitest";

import { buildLineRequest, type SharedQuoteParams } from "../build-request";

/**
 * 成本口径（`cost_basis`）逐行下发 —— 用户 2026-10-24：
 * 「产品成本就在报价中配置，可以选择是否含税」。
 *
 * 口径：勾选「按含税价」= `incl_tax`（引擎按进项税点还原税前成本）；
 * 未勾选 = `pretax`。调用方（报价行卡）总是显式下发；不传则不占字段，
 * 让历史行继续跟随产品定义的 cost_basis。
 */
const shared: SharedQuoteParams = {
  rateSetCode: "",
  fxRate: "7.2",
  quoteCurrency: "USD",
  quoteDate: "2026-10-24",
  validityDays: "30",
  inputVatRatePct: "13",
  giveRatioPct: "",
  outputVatRatePct: "0",
  rebateRatePct: "",
  miscTaxPct: "3",
  profitPct: "10",
};

function request(costBasis?: "pretax" | "incl_tax") {
  return buildLineRequest({
    productKey: "field_fence",
    spec: { height_m: 1.5 },
    total: 100,
    unit: "m",
    shared,
    costBasis,
  });
}

describe("buildLineRequest · 成本口径（cost_basis）", () => {
  it("勾选按含税价 → cost_basis='incl_tax'", () => {
    expect(request("incl_tax").cost_basis).toBe("incl_tax");
  });

  it("未勾选 → cost_basis='pretax'（显式下发，不依赖产品定义缺省）", () => {
    expect(request("pretax").cost_basis).toBe("pretax");
  });

  it("调用方没给口径时不占该字段（历史行继续跟随产品定义）", () => {
    expect(request()).not.toHaveProperty("cost_basis");
  });
});
