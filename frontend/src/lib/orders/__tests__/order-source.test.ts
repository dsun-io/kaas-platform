/**
 * 订单来源纯函数（设计 §3.2 / §8 / §9.2）：文案、深链、建单来源入参、错误口径。
 * 这些被订单列表/详情/建单向导三处共用，必须钉死 —— 漂移会让"来源链"三处说法不一。
 */
import { describe, expect, it } from "vitest";

import {
  buildOrderSourcePayload,
  inquiryDeepLink,
  normalizeOrderSourceType,
  orderConfirmSourceLabel,
  orderSourceChain,
  orderSourceErrorHint,
  orderSourceLabel,
  orderSourceTone,
  ORDER_CHANNEL_FILTER_OPTIONS,
  ORDER_SOURCE_FILTER_OPTIONS,
  quoteRecordsDeepLink,
  validateOrderSourceDraft,
} from "../order-source";

describe("订单来源文案", () => {
  it("询盘转化 / 直接下单 / 直接下单·渠道", () => {
    expect(orderSourceLabel("inquiry", null)).toBe("询盘转化");
    expect(orderSourceLabel("direct", null)).toBe("直接下单");
    expect(orderSourceLabel("direct", "phone")).toBe("直接下单 · 电话");
    expect(orderSourceLabel("inquiry", "expo")).toBe("询盘转化");
  });

  it("历史行 source_type 为空按 direct（与后端 row_to_order 缺省一致）", () => {
    expect(normalizeOrderSourceType(null)).toBe("direct");
    expect(normalizeOrderSourceType(undefined)).toBe("direct");
    expect(normalizeOrderSourceType("bogus")).toBe("direct");
    expect(normalizeOrderSourceType("inquiry")).toBe("inquiry");
  });

  it("徽标色：询盘 info、直接 default", () => {
    expect(orderSourceTone("inquiry")).toBe("info");
    expect(orderSourceTone(null)).toBe("default");
  });

  it("来源链：询盘 → 报价 → 本订单（可点跳）", () => {
    const chain = orderSourceChain({
      order_no: "ORD-1",
      source_type: "inquiry",
      inquiry_id: 7,
      quote_id: 9,
    });
    expect(chain.map((step) => step.label)).toEqual([
      "询盘 #7",
      "报价单 #9",
      "ORD-1",
    ]);
    expect(chain[0]?.href).toBe("/inquiries?inquiry_id=7");
    expect(chain[1]?.href).toBe("/quotes?tab=records");
    expect(chain[2]?.href).toBeNull();
  });

  it("直接下单没有询盘链", () => {
    expect(
      orderSourceChain({
        order_no: "ORD-2",
        source_type: "direct",
        inquiry_id: null,
        quote_id: null,
      }),
    ).toEqual([]);
  });

  it("确认来源人话", () => {
    expect(orderConfirmSourceLabel("manual")).toBe("人工确认");
    expect(orderConfirmSourceLabel("deposit_receipt")).toBe("定金到账联动确认");
    expect(orderConfirmSourceLabel(null)).toBeNull();
  });
});

describe("深链", () => {
  it("只给正整数生成链接（0 / null / NaN 不造死链）", () => {
    expect(inquiryDeepLink(12)).toBe("/inquiries?inquiry_id=12");
    expect(inquiryDeepLink(0)).toBeNull();
    expect(inquiryDeepLink(-1)).toBeNull();
    expect(inquiryDeepLink(null)).toBeNull();
    expect(inquiryDeepLink(1.5)).toBeNull();

    expect(quoteRecordsDeepLink(3)).toBe("/quotes?tab=records");
    expect(quoteRecordsDeepLink(undefined)).toBeNull();
  });
});

describe("建单来源入参", () => {
  it("询盘转化：带 inquiry_id，不带渠道（继承询盘渠道）", () => {
    expect(
      buildOrderSourcePayload({
        sourceType: "inquiry",
        inquiryId: 5,
        sourceChannel: "expo",
      }),
    ).toEqual({ source_type: "inquiry", inquiry_id: 5 });
  });

  it("直接下单：带渠道；空渠道不传", () => {
    expect(
      buildOrderSourcePayload({ sourceType: "direct", sourceChannel: "phone" }),
    ).toEqual({ source_type: "direct", source_channel: "phone" });
    expect(
      buildOrderSourcePayload({ sourceType: "direct", sourceChannel: " " }),
    ).toEqual({
      source_type: "direct",
    });
  });

  it("本地预检拦住「询盘转化但没选询盘」", () => {
    expect(
      validateOrderSourceDraft({ sourceType: "inquiry", inquiryId: null }),
    ).toContain("必须选择询盘");
    expect(
      validateOrderSourceDraft({ sourceType: "inquiry", inquiryId: 3 }),
    ).toBeNull();
    expect(validateOrderSourceDraft({ sourceType: "direct" })).toBeNull();
  });

  it("后端 422 错误码翻译成操作指引；未知码返回 null", () => {
    expect(orderSourceErrorHint("INQUIRY_REQUIRED")).toContain("必须关联询盘");
    expect(orderSourceErrorHint("DIRECT_ORDER_INQUIRY_CONFLICT")).toContain(
      "询盘转化",
    );
    expect(orderSourceErrorHint("INQUIRY_CUSTOMER_MISMATCH")).toContain(
      "不属于本单客户",
    );
    expect(orderSourceErrorHint("SOMETHING_ELSE")).toBeNull();
  });
});

describe("筛选选项", () => {
  it("来源：全部 / 询盘转化 / 直接下单", () => {
    expect(ORDER_SOURCE_FILTER_OPTIONS.map((o) => o.label)).toEqual([
      "全部来源",
      "询盘转化",
      "直接下单",
    ]);
  });

  it("渠道清单与询盘渠道共用一份（8 个枚举 + 全部）", () => {
    const values = ORDER_CHANNEL_FILTER_OPTIONS.map((o) => o.value);
    expect(values).toEqual([
      "",
      "email",
      "whatsapp",
      "alibaba",
      "expo",
      "website",
      "phone",
      "referral",
      "other",
    ]);
  });
});
