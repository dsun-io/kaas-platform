/**
 * 询盘多产品行（设计稿 §5 + §13.1 方案 A）纯逻辑单测：
 * - 读取：items 优先；items 为空时用旧标量字段合成（历史数据兼容）；
 * - 提交：items[] + 第一行同步旧字段；空行丢弃；数量非法给可读错误。
 */
import { describe, expect, it } from "vitest";

import {
  buildInquiryPayload,
  displayInquiryItems,
  emptyInquiryItemRow,
  inquiryProductSummary,
  resolveProductKey,
  splitProductName,
  type InquiryItemFormRow,
  type InquiryItem,
} from "../inquiry-items";

function row(patch: Partial<InquiryItemFormRow>): InquiryItemFormRow {
  return { ...emptyInquiryItemRow("row-1"), ...patch };
}

describe("splitProductName", () => {
  it("把规格从产品名里拆出来", () => {
    expect(splitProductName("牛栏网 2.5mm × 1.5m")).toEqual({
      name: "牛栏网",
      spec: "2.5mm × 1.5m",
    });
  });

  it("没有规格时整串当产品名", () => {
    expect(splitProductName("勾花网")).toEqual({ name: "勾花网", spec: null });
  });

  it("空值显示未填写产品", () => {
    expect(splitProductName(null)).toEqual({ name: "未填写产品", spec: null });
    expect(splitProductName("   ")).toEqual({ name: "未填写产品", spec: null });
  });
});

describe("displayInquiryItems（items 优先）", () => {
  const items: InquiryItem[] = [
    {
      product_key: "chain-link",
      product_name_raw: "勾花网",
      spec_text: "2.5mm 热镀锌",
      quantity: 1000,
      quantity_unit: "㎡",
      application: "围栏",
    },
    {
      // 新数据也可能只写旧式「名称 + 规格」一串（没有 spec_text）：按旧口径拆开
      product_name_raw: "牛栏网 2.5mm × 1.5m",
      quantity: 500,
      quantity_unit: "m",
      application: "牧场",
    },
  ];

  it("有多产品行时全部展示（不再只看 product_name_raw）", () => {
    const views = displayInquiryItems({
      items,
      // 旧字段是第一行摘要，items 存在时不应重复使用
      product_name_raw: "勾花网",
      quantity: 1000,
    });
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      productKey: "chain-link",
      name: "勾花网",
      spec: "2.5mm 热镀锌",
      quantity: 1000,
      quantityUnit: "㎡",
      application: "围栏",
    });
    expect(views[1]).toMatchObject({
      productKey: null,
      name: "牛栏网",
      spec: "2.5mm × 1.5m",
      quantity: 500,
      quantityUnit: "m",
      application: "牧场",
    });
  });

  it("items 为空数组时回退旧标量字段（历史询盘照常显示）", () => {
    const views = displayInquiryItems({
      items: [],
      product_name_raw: "牛栏网 2.5mm × 1.5m",
      quantity: 500,
      quantity_unit: "m",
      application: "牧场",
    });
    expect(views).toEqual([
      {
        productKey: null,
        name: "牛栏网",
        spec: "2.5mm × 1.5m",
        quantity: 500,
        quantityUnit: "m",
        application: "牧场",
      },
    ]);
  });

  it("没有 items 字段时同样回退旧字段", () => {
    const views = displayInquiryItems({ product_name_raw: "勾花网", quantity: 20 });
    expect(views).toHaveLength(1);
    expect(views[0]?.name).toBe("勾花网");
    expect(views[0]?.quantity).toBe(20);
  });

  it("历史询盘什么都没填时返回空数组", () => {
    expect(displayInquiryItems({})).toEqual([]);
    expect(displayInquiryItems({ items: null, product_name_raw: null })).toEqual([]);
  });

  it("items 里的脏元素被跳过（不因单条坏数据白屏）", () => {
    const views = displayInquiryItems({
      items: [null as unknown as InquiryItem, items[0]!],
    });
    expect(views).toHaveLength(1);
    expect(views[0]?.name).toBe("勾花网");
  });
});

describe("inquiryProductSummary", () => {
  it("单个 / 两个产品直接列名", () => {
    expect(
      inquiryProductSummary([
        { productKey: null, name: "勾花网", spec: null, quantity: null, quantityUnit: null, application: null },
      ]),
    ).toBe("勾花网");
    expect(
      inquiryProductSummary([
        { productKey: null, name: "勾花网", spec: null, quantity: null, quantityUnit: null, application: null },
        { productKey: null, name: "牛栏网", spec: null, quantity: null, quantityUnit: null, application: null },
      ]),
    ).toBe("勾花网、牛栏网");
  });

  it("三个以上折叠成「甲、乙 等 N 个产品」", () => {
    const view = (name: string) => ({
      productKey: null,
      name,
      spec: null,
      quantity: null,
      quantityUnit: null,
      application: null,
    });
    expect(inquiryProductSummary([view("甲"), view("乙"), view("丙")])).toBe(
      "甲、乙 等 3 个产品",
    );
  });

  it("没有产品行时显示未填写产品", () => {
    expect(inquiryProductSummary([])).toBe("未填写产品");
  });
});

describe("resolveProductKey", () => {
  const options = [
    { product_key: "chain-link", name: "勾花网" },
    { product_key: "cattle-fence", name: "牛栏网" },
  ];

  it("名称精确命中产品库时带出 key", () => {
    expect(resolveProductKey(" 勾花网 ", options)).toBe("chain-link");
  });

  it("手输产品不猜 key", () => {
    expect(resolveProductKey("勾花网 2.5mm", options)).toBeNull();
    expect(resolveProductKey("", options)).toBeNull();
  });
});

describe("buildInquiryPayload", () => {
  it("两行产品 → items[]，同时第一行同步进旧字段", () => {
    const { payload, error } = buildInquiryPayload({
      channel: "email",
      notes: " 客户要样品 ",
      rows: [
        row({
          product: "勾花网",
          product_key: "chain-link",
          spec_text: " 2.5mm 热镀锌 ",
          quantity: "1000",
          quantity_unit: "㎡",
          application: "围栏",
        }),
        row({
          id: "row-2",
          product: "牛栏网",
          quantity: "500",
          quantity_unit: "m",
          application: "牧场",
        }),
      ],
    });
    expect(error).toBeNull();
    expect(payload.channel).toBe("email");
    expect(payload.notes).toBe("客户要样品");
    expect(payload.items).toEqual([
      {
        product_key: "chain-link",
        product_name_raw: "勾花网",
        spec_text: "2.5mm 热镀锌",
        quantity: 1000,
        quantity_unit: "㎡",
        application: "围栏",
      },
      {
        product_name_raw: "牛栏网",
        quantity: 500,
        quantity_unit: "m",
        application: "牧场",
      },
    ]);
    // 旧字段兼容：第一行
    expect(payload.product_name_raw).toBe("勾花网");
    expect(payload.quantity).toBe(1000);
    expect(payload.quantity_unit).toBe("㎡");
    expect(payload.application).toBe("围栏");
  });

  it("空行被丢弃（不会产生空明细）", () => {
    const { payload } = buildInquiryPayload({
      channel: "",
      notes: "",
      rows: [
        row({ product: "勾花网", quantity: "10" }),
        row({ id: "row-2" }),
      ],
    });
    expect(payload.items).toHaveLength(1);
    expect(payload.items?.[0]?.product_name_raw).toBe("勾花网");
  });

  it("一行都没填时只发渠道/备注（保持旧版行为，不发明细）", () => {
    const { payload, error } = buildInquiryPayload({
      channel: "whatsapp",
      notes: "先电话沟通",
      rows: [row({})],
    });
    expect(error).toBeNull();
    expect(payload.items).toBeUndefined();
    expect(payload.product_name_raw).toBeUndefined();
    expect(payload.channel).toBe("whatsapp");
    expect(payload.notes).toBe("先电话沟通");
  });

  it("数量填字母时给可读错误、不发请求数据", () => {
    const { payload, error } = buildInquiryPayload({
      channel: "",
      notes: "",
      rows: [row({ product: "勾花网", quantity: "十个" })],
    });
    expect(error).toBe("第 1 行产品的数量请填数字");
    expect(payload).toEqual({});
  });

  it("数量允许小数", () => {
    const { payload } = buildInquiryPayload({
      channel: "",
      notes: "",
      rows: [row({ product: "勾花网", quantity: "2.5" })],
    });
    expect(payload.quantity).toBe(2.5);
  });
});
