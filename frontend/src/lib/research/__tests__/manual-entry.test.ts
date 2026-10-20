/**
 * 调研手工录入纯函数（C36 #22）：校验、POST 组装、409 线索冲突解释。
 */
import { describe, expect, it } from "vitest";

import {
  buildManualResearchPayload,
  EMPTY_MANUAL_RESEARCH_FORM,
  explainResearchConflict,
  validateManualResearchForm,
} from "../manual-entry";

describe("validateManualResearchForm", () => {
  it("产品名与线索都没有 → 报错；价格非法 → 报错", () => {
    expect(validateManualResearchForm(EMPTY_MANUAL_RESEARCH_FORM)).toEqual([
      "产品名或「从线索挑选」至少填一个",
    ]);
    expect(
      validateManualResearchForm({
        ...EMPTY_MANUAL_RESEARCH_FORM,
        productName: "chain link fence",
        priceLocal: "abc",
      }),
    ).toEqual(["本地价格必须是非负数字"]);
    expect(
      validateManualResearchForm({
        ...EMPTY_MANUAL_RESEARCH_FORM,
        productName: "chain link fence",
        priceLocal: "-1",
      }),
    ).toEqual(["本地价格必须是非负数字"]);
  });

  it("只选线索也合法（产品字段由后端回填）", () => {
    expect(
      validateManualResearchForm({
        ...EMPTY_MANUAL_RESEARCH_FORM,
        sourceRef: "9",
      }),
    ).toEqual([]);
  });
});

describe("buildManualResearchPayload", () => {
  it("空串不送；source_ref/价格转数字；can_supply 三态", () => {
    expect(
      buildManualResearchPayload({
        ...EMPTY_MANUAL_RESEARCH_FORM,
        sourceRef: "9",
        productName: " chain link fence ",
        productNameCn: "",
        productCategory: "gabion",
        country: "DE",
        priceLocal: "12.5",
        priceCurrency: "EUR",
        canSupply: "false",
        marketNote: "  ",
      }),
    ).toEqual({
      source_ref: 9,
      product_name: "chain link fence",
      product_category: "gabion",
      country: "DE",
      price_local: 12.5,
      price_currency: "EUR",
      can_supply: false,
    });
  });

  it("未填能供货/价格时省略", () => {
    const body = buildManualResearchPayload({
      ...EMPTY_MANUAL_RESEARCH_FORM,
      productName: "gabion",
      canSupply: "",
      priceLocal: "",
    });
    expect(body).toEqual({ product_name: "gabion" });
  });
});

describe("explainResearchConflict", () => {
  const conflict = {
    response: {
      status: 409,
      data: {
        detail: { error: "conflict", code: "ALREADY_PICKED", research_id: 12 },
      },
    },
  };

  it("409 ALREADY_PICKED → 带 research_id 的专属文案", () => {
    expect(explainResearchConflict(conflict)).toBe(
      "该线索已在调研集中（调研产品 #12），不能重复挑选",
    );
  });

  it("非 409 → null（交给通用错误展示）", () => {
    expect(
      explainResearchConflict({
        response: { status: 500, data: {} },
        message: "boom",
      }),
    ).toBeNull();
  });
});
