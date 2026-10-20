/**
 * 单证「中译英」纯逻辑（`lib/trade-doc/translate.ts`）单测。
 *
 * 钉住三件事：
 * 1. **字段抽取口径**：只收 manifest 声明 + `control=text` + 值是非空字符串 + 含汉字；
 *    日期/数字/布尔/对象/图片与"已填英文"的字段都不进列表（18 类单证靠 manifest，不手写）。
 * 2. **请求体**：只带勾选字段的原文。
 * 3. **降级语义**：`path=template` 必须被识别为"AI 不可用（原样返回）"，
 *    `path=ai:<provider>` 才算 AI 翻译；两者不能混。
 */
import { describe, expect, it } from "vitest";

import {
  aiProviderOf,
  buildTranslateFields,
  collectTranslatableFields,
  hasCjk,
  isTemplateFallback,
  isUnchangedTranslation,
  translatePathLabel,
} from "../translate";

describe("hasCjk", () => {
  it("中文/中英混输为 true，纯英文/数字/空为 false", () => {
    expect(hasCjk("请尽快发货")).toBe(true);
    expect(hasCjk("FOB 天津")).toBe(true);
    expect(hasCjk("N/M")).toBe(false);
    expect(hasCjk("Please ship ASAP")).toBe(false);
    expect(hasCjk("")).toBe(false);
  });
});

describe("collectTranslatableFields · 从 raw_payload.custom 抽中文字段", () => {
  it("PI：只收含汉字的手工文本字段（英文/编号/布尔/图片/对象都不收）", () => {
    const fields = collectTranslatableFields("pi", {
      remarks: "  请尽快发货  ",
      country_of_origin: "中国",
      shipping_marks: "N/M",
      payment_terms: "T/T 30% deposit",
      pi_no: "PI-2026-001",
      buyer_confirmation: true,
      company_stamp: "data:image/png;base64,AAAA",
      product_photos: [{ image: "data:image/png;base64,BBBB" }],
    });
    // 顺序跟 manifest 一致（country_of_origin 在 remarks 之前）
    expect(fields.map((field) => field.name)).toEqual([
      "country_of_origin",
      "remarks",
    ]);
    expect(fields[1]).toMatchObject({
      name: "remarks",
      text: "请尽快发货", // 去掉首尾空白，避免把空白当内容
    });
    expect(fields[1]!.label).toContain("备注");
  });

  it("合同：条款类字段（检验/索赔/不可抗力/仲裁/签发地）都能抽到", () => {
    const fields = collectTranslatableFields("contract", {
      inspection: "第三方检验",
      claims: "按合同约定索赔",
      force_majeure: "不可抗力",
      arbitration: "中国国际经济贸易仲裁委员会",
      place_of_issue: "上海",
      contract_no: "SC-2026-001", // 编号不含汉字 ⇒ 不收
    });
    expect(fields.map((field) => field.name)).toEqual([
      "inspection",
      "claims",
      "force_majeure",
      "arbitration",
      "place_of_issue",
    ]);
  });

  it("null / 空 custom / 未知单证类型 → 空列表（不猜字段）", () => {
    expect(collectTranslatableFields("pi", null)).toEqual([]);
    expect(collectTranslatableFields("pi", undefined)).toEqual([]);
    expect(collectTranslatableFields("pi", {})).toEqual([]);
    expect(collectTranslatableFields("no_such_doc_type", { remarks: "中文" })).toEqual(
      [],
    );
  });

  it("非字符串值（数字/对象）即使出现在文本字段名上也不收", () => {
    expect(
      collectTranslatableFields("pi", { remarks: 123, shipping_marks: { a: 1 } }),
    ).toEqual([]);
  });
});

describe("buildTranslateFields · 只带勾选字段的原文", () => {
  const fields = [
    { name: "remarks", label: "备注", text: "请尽快发货" },
    { name: "shipping_marks", label: "唛头", text: "河北安平" },
  ];

  it("默认全选；显式取消的不带", () => {
    expect(buildTranslateFields(fields, {})).toEqual({
      remarks: "请尽快发货",
      shipping_marks: "河北安平",
    });
    expect(buildTranslateFields(fields, { shipping_marks: false })).toEqual({
      remarks: "请尽快发货",
    });
    expect(
      buildTranslateFields(fields, { remarks: false, shipping_marks: false }),
    ).toEqual({});
  });
});

describe("路径语义 · template 是降级，不是翻译成功", () => {
  it("isTemplateFallback 只认 template", () => {
    expect(isTemplateFallback("template")).toBe(true);
    expect(isTemplateFallback("ai:kimi")).toBe(false);
    expect(isTemplateFallback("none")).toBe(false);
  });

  it("aiProviderOf 解析 provider；非 AI 路径为 null", () => {
    expect(aiProviderOf("ai:kimi")).toBe("kimi");
    expect(aiProviderOf("ai:deepseek")).toBe("deepseek");
    expect(aiProviderOf("template")).toBeNull();
    expect(aiProviderOf("ai:")).toBeNull();
    expect(aiProviderOf("none")).toBeNull();
  });

  it("translatePathLabel 如实描述 path（template = AI 不可用原样返回）", () => {
    expect(translatePathLabel("template")).toContain("AI 不可用");
    expect(translatePathLabel("template")).toContain("原样返回");
    expect(translatePathLabel("ai:kimi")).toContain("AI 翻译（kimi）");
    expect(translatePathLabel("none")).toContain("没有可翻译");
  });

  it("isUnchangedTranslation 用来标「未翻译（回退原文）」", () => {
    expect(isUnchangedTranslation("请尽快", "请尽快")).toBe(true);
    expect(isUnchangedTranslation(" 请尽快 ", "请尽快")).toBe(true);
    expect(isUnchangedTranslation("请尽快", "Please ship ASAP")).toBe(false);
  });
});
