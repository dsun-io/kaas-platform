/**
 * 开单前「成品预览」数据装配（纯函数）：
 * 样板底稿 + 当前表单已填值（币种 / 业务客户 / 上游贸易条款），零网络零写入。
 */
import { describe, expect, it } from "vitest";

import { buildCreatePreviewData } from "../create-preview";
import sampleData from "../sample-data.json";

const SAMPLE = sampleData as unknown as {
  base: Record<string, unknown>;
  other_extra?: Record<string, unknown>;
};

describe("buildCreatePreviewData", () => {
  it("没有单证类型时返回 null（不造假预览）", () => {
    expect(buildCreatePreviewData({ docType: "" })).toBeNull();
    expect(buildCreatePreviewData({ docType: "   " })).toBeNull();
  });

  it("币种与业务客户来自当前表单；买方其余信息保留样板占位", () => {
    const preview = buildCreatePreviewData({
      docType: "ci",
      currency: "eur",
      customerName: "客户A",
    })!;

    expect(preview.docType).toBe("ci");
    expect(preview.data.currency).toBe("EUR");
    expect((preview.data.buyer as Record<string, unknown>).company).toBe(
      "客户A",
    );
    expect(preview.fromForm).toEqual(["币种", "业务客户"]);
    // 表单没有的字段保持样板底稿（预览只覆盖「确实已填」的值）
    expect(preview.data.total_amount).toBe(SAMPLE.base.total_amount);
    expect((preview.data.buyer as Record<string, unknown>).address).toBe(
      (SAMPLE.base.buyer as Record<string, unknown>).address,
    );
  });

  it("选中的上游只覆盖有值的贸易条款（空值不冲掉底稿）", () => {
    const preview = buildCreatePreviewData({
      docType: "ci",
      currency: "USD",
      customerName: "客户A",
      upstream: {
        incoterm: "FOB Shanghai",
        payment_terms: "  ",
        port_of_loading: "Shanghai",
        port_of_destination: "Hamburg",
        shipping_marks: null,
        country_of_origin: "China",
      },
    })!;

    expect(preview.data.incoterm).toBe("FOB Shanghai");
    expect(preview.data.port_of_destination).toBe("Hamburg");
    // 空白/未提供 ⇒ 保留样板底稿，而不是写成空串
    expect(preview.data.payment_terms).toBe(SAMPLE.base.payment_terms);
    expect(preview.data.shipping_marks).toBe(SAMPLE.base.shipping_marks);
    expect(preview.fromForm).toContain("贸易术语");
    expect(preview.fromForm).toContain("原产国");
  });

  it("other 类型带上 other_extra（title/content），与样板预览同口径", () => {
    const preview = buildCreatePreviewData({
      docType: "other",
      currency: "USD",
      customerName: "客户A",
    })!;
    expect(preview.data.title).toBe(SAMPLE.other_extra?.title);
    expect(preview.data.content).toBe(SAMPLE.other_extra?.content);
  });

  it("不改动样板数据本身（同一模块被样板预览与逐字节基线共用）", () => {
    const before = JSON.stringify(SAMPLE.base);
    buildCreatePreviewData({
      docType: "ci",
      currency: "EUR",
      customerName: "客户A",
      upstream: { incoterm: "CIF" },
    });
    expect(JSON.stringify(SAMPLE.base)).toBe(before);
  });
});
