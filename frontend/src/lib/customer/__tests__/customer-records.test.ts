import { describe, expect, it } from "vitest";

import {
  EMPTY_CUSTOMER_RECORDS,
  defaultQuoteExpanded,
  formatRecordCounts,
  hasAnyRecord,
  normalizeCustomerRecords,
} from "../customer-records";

/**
 * 这组测试守的是**降级**：客户页是主流程页面，
 * 「往来记录」接口哪怕返回垃圾（404 空体 / 网关 HTML / 缺字段的半成品），
 * 归一出空树即可，绝不能抛异常把整页打崩。
 */
describe("normalizeCustomerRecords", () => {
  it("按设计文档 §3 的完整响应解析出树与计数", () => {
    const records = normalizeCustomerRecords({
      customer: { id: 7, name: "Tim Trading", team_id: 1 },
      counts: { quotes: 3, orders: 2, documents: 6 },
      quotes: [
        {
          id: 4,
          quote_no: "QUO-202609-0004",
          status: "accepted",
          currency: "USD",
          total_amount: 12300,
          created_at: "2026-09-27T14:56:42Z",
          documents: [
            {
              id: 12,
              doc_no: "QUO-202609-0004",
              doc_type: "quotation",
              status: "issued",
            },
          ],
          orders: [
            {
              id: 1,
              order_no: "ORD-202609-0001",
              status: "confirmed",
              currency: "USD",
              total_amount: 12300,
              created_at: "2026-09-28T09:10:00Z",
              documents: [
                {
                  id: 3,
                  doc_no: "PI-202609-0002",
                  doc_type: "pi",
                  status: "draft",
                },
                {
                  id: 2,
                  doc_no: "CI-202609-0001",
                  doc_type: "ci",
                  status: "issued",
                },
              ],
            },
          ],
        },
      ],
      direct: {
        orders: [
          {
            id: 9,
            order_no: "ORD-202609-0009",
            status: "confirmed",
            documents: [{ doc_no: "PL-202609-0003", doc_type: "pl" }],
          },
        ],
        documents: [
          { id: 2, doc_no: "CI-202609-0001", doc_type: "ci", status: "issued" },
        ],
      },
    });

    expect(records.customerName).toBe("Tim Trading");
    expect(records.counts).toEqual({ quotes: 3, orders: 2, documents: 6 });
    expect(records.quotes).toHaveLength(1);
    expect(records.quotes[0]?.quote_no).toBe("QUO-202609-0004");
    expect(records.quotes[0]?.documents[0]?.doc_type).toBe("quotation");
    expect(
      records.quotes[0]?.orders[0]?.documents.map((d) => d.doc_type),
    ).toEqual(["pi", "ci"]);
    // direct 是"直接挂客户"的正规路径，一条都不能丢
    expect(records.direct.orders[0]?.documents[0]?.doc_no).toBe(
      "PL-202609-0003",
    );
    expect(records.direct.documents[0]?.doc_no).toBe("CI-202609-0001");
  });

  it("接口没给 counts 时从树上数出来（含 direct 与订单下的单证）", () => {
    const records = normalizeCustomerRecords({
      quotes: [
        {
          id: 1,
          quote_no: "Q-1",
          documents: [{ doc_no: "Q-1", doc_type: "quotation" }],
          orders: [
            {
              id: 1,
              order_no: "O-1",
              documents: [{ doc_no: "PI-1", doc_type: "pi" }],
            },
          ],
        },
      ],
      direct: {
        orders: [
          {
            id: 2,
            order_no: "O-2",
            documents: [{ doc_no: "BL-1", doc_type: "bl" }],
          },
        ],
        documents: [{ doc_no: "CI-9", doc_type: "ci" }],
      },
    });

    // 报价 1；订单 = 报价下 1 + direct 1 = 2；
    // 单证 = 报价单 1 + 订单 PI 1 + direct 订单 BL 1 + direct 单证 1 = 4
    expect(records.counts).toEqual({ quotes: 1, orders: 2, documents: 4 });
  });

  it("喂垃圾也不抛：null / 字符串 / 数组 / 缺字段对象都退化成空树", () => {
    for (const garbage of [
      null,
      undefined,
      "not json",
      42,
      [],
      {},
      { quotes: "nope", direct: 7, counts: null, customer: "x" },
      { quotes: [null, 3, {}], direct: { orders: [null], documents: [1] } },
    ]) {
      expect(() => normalizeCustomerRecords(garbage)).not.toThrow();
      const records = normalizeCustomerRecords(garbage);
      expect(Array.isArray(records.quotes)).toBe(true);
      expect(Array.isArray(records.direct.orders)).toBe(true);
      expect(Array.isArray(records.direct.documents)).toBe(true);
      expect(hasAnyRecord(records)).toBe(false);
    }
  });

  it("没有 doc_type / doc_no 的空行被丢掉，不渲染空 chip", () => {
    const records = normalizeCustomerRecords({
      quotes: [
        {
          quote_no: "Q-1",
          documents: [{ status: "draft" }, { doc_no: "PI-1", doc_type: "pi" }],
        },
      ],
    });
    expect(records.quotes[0]?.documents).toHaveLength(1);
  });

  it("兼容只有 documents（没有 direct 包裹）的扁平形状", () => {
    const records = normalizeCustomerRecords({
      documents: [{ doc_no: "CI-1", doc_type: "ci" }],
    });
    expect(records.direct.documents).toHaveLength(1);
  });

  it("金额用字符串传（Decimal）也能解析", () => {
    const records = normalizeCustomerRecords({
      quotes: [{ id: 1, quote_no: "Q-1", total_amount: "12300.50" }],
    });
    expect(records.quotes[0]?.total_amount).toBe(12300.5);
  });
});

describe("记录计数与默认展开", () => {
  it("formatRecordCounts 与设计文档的标题写法一致", () => {
    expect(formatRecordCounts({ quotes: 3, orders: 2, documents: 6 })).toBe(
      "3 报价 · 2 订单 · 6 单证",
    );
  });

  it("含订单的报价默认展开，纯草稿折叠", () => {
    const base = { id: 1, quote_no: "Q", status: "draft" };
    expect(
      defaultQuoteExpanded({
        ...base,
        status: "draft",
        currency: null,
        total_amount: null,
        created_at: null,
        inquiry_id: null,
        documents: [],
        orders: [],
      }),
    ).toBe(false);
    expect(
      defaultQuoteExpanded({
        ...base,
        status: "accepted",
        currency: null,
        total_amount: null,
        created_at: null,
        inquiry_id: null,
        documents: [],
        orders: [
          {
            id: 2,
            order_no: "O-1",
            status: "confirmed",
            currency: null,
            total_amount: null,
            created_at: null,
            documents: [],
          },
        ],
      }),
    ).toBe(true);
  });

  it("空树的计数是 0", () => {
    expect(EMPTY_CUSTOMER_RECORDS.counts).toEqual({
      quotes: 0,
      orders: 0,
      documents: 0,
    });
  });
});
