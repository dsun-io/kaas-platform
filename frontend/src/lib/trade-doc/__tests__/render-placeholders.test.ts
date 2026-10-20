/**
 * 字段体检（TODO A3）单测：`findBlankPlaceholders` 的分类与排除口径。
 *
 * 为什么要这层测试：渲染器「缺失键渲染为空串」是既定口径（不能改成报错，
 * 否则历史单据与第三方数据会集体渲染失败），所以"拼错/漏登记只是静静空白"
 * 只能靠**显式的字段体检**暴露 —— 这里锁住它的分类语义，防止以后被改回去。
 */
import { describe, expect, it } from "vitest";

import manifest from "../manifest.json";
import { findBlankPlaceholders } from "../render";

const DOC_TYPES = Object.keys(manifest);

const DERIVED_OR_DESIGNED = new Set([
  // 渲染器自动派生
  "total_amount_words",
  "insured_amount_words",
  "seller_name",
  "footer_note",
  "total_qty",
  "total_packages",
  "total_gross_weight",
  "total_net_weight",
  "total_volume",
  // 按设计默认为空（图片位/产品图/买方回签栏）
  "company_stamp",
  "product_photos",
  "buyer_confirmation",
]);

describe("findBlankPlaceholders", () => {
  it("18 类单据的模板占位符全部在 manifest 登记（未登记 = 拼错或模板漏登）", () => {
    for (const docType of DOC_TYPES) {
      const audit = findBlankPlaceholders(docType, {});
      expect(audit.undeclared, `${docType} 有未登记占位符`).toEqual([]);
    }
  });

  it("派生字段与按设计为空的字段不参与体检", () => {
    for (const docType of DOC_TYPES) {
      const audit = findBlankPlaceholders(docType, {});
      const all = [
        ...audit.undeclared,
        ...audit.blankRequired,
        ...audit.blankOptional,
      ].map((x) => x.key);
      for (const key of all) {
        expect(DERIVED_OR_DESIGNED.has(key), `${docType} 不应报告 ${key}`).toBe(
          false,
        );
      }
    }
  });

  it("空数据下：必填缺口进入 blankRequired（带 manifest 中文说明）", () => {
    const audit = findBlankPlaceholders("pi", {});
    const keys = audit.blankRequired.map((x) => x.key);
    expect(keys).toContain("pi_no");
    expect(keys).toContain("seller");
    const piNo = audit.blankRequired.find((x) => x.key === "pi_no");
    expect(piNo?.label).toBe("PI 编号");
    expect(piNo?.declared).toBe(true);
  });

  it("填上字段后从 blankRequired 消失（体检值跟着数据走）", () => {
    const empty = findBlankPlaceholders("pi", {});
    expect(empty.blankRequired.map((x) => x.key)).toContain("pi_no");

    const filled = findBlankPlaceholders("pi", { pi_no: "PI-202610-0001" });
    expect(filled.blankRequired.map((x) => x.key)).not.toContain("pi_no");
  });

  it("可选字段留空进入 blankOptional（提示但不拦签发）", () => {
    const audit = findBlankPlaceholders("pi", {});
    expect(audit.blankOptional.length).toBeGreaterThan(0);
    for (const item of audit.blankOptional) {
      expect(item.declared).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("未知单证类型抛错（调用方负责兜底，预览据此不崩）", () => {
    expect(() => findBlankPlaceholders("not_a_doc", {})).toThrow();
  });
});
