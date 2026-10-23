import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { BusinessSpecEditor } from "../business-spec-editor";
import type { ProductSpec } from "@/lib/products/tenant-products";

const spec: ProductSpec = {
  key: "chain_link",
  numeric_inputs: [
    {
      key: "d",
      label: "丝径/线径",
      unit: "mm",
      default: 2.5,
      min_value: 0.3,
      max_value: 8,
    },
  ],
  variants: [
    {
      name: "coating",
      label: "表面处理",
      options: [{ name: "热镀锌", label: "热镀锌" }],
    },
  ],
  packaging: [
    {
      id: "p1",
      name: "编织袋",
      method: "编织袋+钢带",
      is_default: true,
      amount: 12,
    },
  ],
  hs_codes: ["7314410000"],
  derived: [{ name: "weight" }],
};

describe("产品规格业务层编辑器", () => {
  it("只展示业务字段，不出现产品 key/JSON/公式/内部字段名", () => {
    const html = renderToStaticMarkup(
      <BusinessSpecEditor spec={spec} onChange={() => {}} />,
    );
    expect(html).toContain("规格参数");
    expect(html).toContain("丝径/线径");
    expect(html).toContain("最小值");
    expect(html).toContain("最大值");
    // 2026-10-23：可选档位（表面处理）与 HS 编码已移入产品「基本信息」区
    expect(html).not.toContain("可选档位");
    expect(html).not.toContain("HS 编码");
    // 包装区保留，但不再叫「包装费」，且行内无「包装名称」（只有包装方式/默认/金额）
    expect(html).toContain("包装");
    expect(html).toContain("包装方式");
    expect(html).toContain("编织袋+钢带");
    expect(html).toContain("默认");
    expect(html).not.toContain("包装名称");
    expect(html).not.toContain("包装费");
    expect(html).not.toContain("numeric_inputs");
    expect(html).not.toContain("derived");
    expect(html).not.toContain("JSON");
    expect(html).not.toContain("chain_link");
    expect(html).not.toContain("公式");
  });

  it("没有规格参数时给出人话说明，而不是空表", () => {
    const html = renderToStaticMarkup(
      <BusinessSpecEditor spec={{ key: "x" }} onChange={() => {}} />,
    );
    expect(html).toContain("没有需要客户填写的规格参数");
    expect(html).toContain("还没有包装");
  });
});
