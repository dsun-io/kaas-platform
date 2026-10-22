// @vitest-environment node
/**
 * 询盘工位纯逻辑（lib/inquiries/*）单测。
 *
 * 钉死三件事：
 *  1. 筛选参数**只**映射后端 Query 名，且**不生成 page/page_size**
 *     （内核 list_inquiries 没有分页参数，生成就是假分页）；
 *  2. 阶段解析：后端 stage 真值优先；status=closed 优先展示「关闭」；
 *     关闭后重开留下的陈旧 stage=closed 必须按 status 退化（否则永远停在关闭）；
 *  3. 编辑 payload：只发改过的字段、空行丢弃、数量非数字前端拦截、
 *     渠道不能清空（内核 validate_enum 不收空值）。
 */
import { describe, expect, it } from "vitest";

import {
  buildInquiryUpdatePayload,
  draftFromDetail,
  emptyInquiryItemDraftRow,
  itemDraftRows,
} from "../edit";
import {
  EMPTY_INQUIRY_FILTERS,
  INQUIRIES_PAGE_SIZE,
  hasActiveInquiryFilters,
  inquiryQuoteHref,
  isInquiryDate,
  orderDetailHref,
  paginateInquiryRows,
  toInquiryQueryParams,
  validateInquiryFilters,
} from "../filters";
import {
  CHANNEL_LABEL,
  channelLabel,
  formatInquiryDate,
  formatInquiryDateTime,
  formatInquiryMoney,
  inquiryItemViews,
  inquiryProductSummary,
} from "../format";
import {
  canCloseInquiry,
  inquiryStatusLabel,
  reopenStatus,
  resolveInquiryStage,
  stageTimeline,
} from "../stage";
import type { InquiryBase, InquiryItem, InquiryStageLog } from "../types";

describe("toInquiryQueryParams：只映射后端 Query 名，不造假分页", () => {
  it("空筛选 → 空参数对象（不发 ?stage= 这种空值）", () => {
    expect(toInquiryQueryParams(EMPTY_INQUIRY_FILTERS)).toEqual({});
    expect(hasActiveInquiryFilters(EMPTY_INQUIRY_FILTERS)).toBe(false);
  });

  it("全字段映射：customerId → customer_id，dateFrom → date_from，q 去空格", () => {
    const params = toInquiryQueryParams({
      status: "quoted",
      stage: "order",
      channel: "expo",
      customerId: "7",
      dateFrom: "2026-10-01",
      dateTo: "2026-10-31",
      q: "  牛栏网  ",
    });
    expect(params).toEqual({
      status: "quoted",
      stage: "order",
      channel: "expo",
      customer_id: "7",
      date_from: "2026-10-01",
      date_to: "2026-10-31",
      q: "牛栏网",
    });
    // 内核没有分页参数 —— 一旦这里出现 page，就是「mock 能翻页、生产翻不动」
    expect(params).not.toHaveProperty("page");
    expect(params).not.toHaveProperty("page_size");
  });

  it("纯空白关键字不落参数", () => {
    expect(
      toInquiryQueryParams({ ...EMPTY_INQUIRY_FILTERS, q: "   " }),
    ).toEqual({});
  });
});

describe("日期预检（与后端 422 INVALID_DATE 同口径）", () => {
  it("严格 YYYY-MM-DD，拒绝不存在的日期", () => {
    expect(isInquiryDate("2026-10-22")).toBe(true);
    expect(isInquiryDate("2026-02-31")).toBe(false);
    expect(isInquiryDate("2026-1-1")).toBe(false);
    expect(isInquiryDate("")).toBe(false);
  });

  it("非法日期 / 起止倒置都给出可读错误", () => {
    expect(
      validateInquiryFilters({
        ...EMPTY_INQUIRY_FILTERS,
        dateFrom: "2026/10/01",
      }),
    ).toBe("开始日期必须是 YYYY-MM-DD");
    expect(
      validateInquiryFilters({
        ...EMPTY_INQUIRY_FILTERS,
        dateTo: "2026-13-01",
      }),
    ).toBe("结束日期必须是 YYYY-MM-DD");
    expect(
      validateInquiryFilters({
        ...EMPTY_INQUIRY_FILTERS,
        dateFrom: "2026-10-20",
        dateTo: "2026-10-10",
      }),
    ).toBe("开始日期不能晚于结束日期");
    expect(validateInquiryFilters(EMPTY_INQUIRY_FILTERS)).toBeNull();
  });
});

describe("客户端分页（内核不支持分页，切片在前端）", () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ id: i + 1 }));

  it("每页 20 条，第 2 页是 21–40", () => {
    expect(INQUIRIES_PAGE_SIZE).toBe(20);
    const page2 = paginateInquiryRows(rows, 2);
    expect(page2.rows[0]?.id).toBe(21);
    expect(page2.rows).toHaveLength(20);
    expect(page2.from).toBe(21);
    expect(page2.to).toBe(40);
    expect(page2.totalPages).toBe(3);
  });

  it("末页按实际条数；越界页码夹紧到末页", () => {
    const last = paginateInquiryRows(rows, 3);
    expect(last.rows).toHaveLength(5);
    expect(last.from).toBe(41);
    expect(last.to).toBe(45);
    expect(paginateInquiryRows(rows, 99).page).toBe(3);
  });

  it("空列表 from/to 都是 0", () => {
    const empty = paginateInquiryRows([], 1);
    expect(empty).toMatchObject({ from: 0, to: 0, total: 0, totalPages: 1 });
  });
});

describe("深链（与 customers 页逐字一致）", () => {
  it("为此询盘报价 = /quotes?tab=product&customer_id=&inquiry_id=", () => {
    expect(inquiryQuoteHref({ id: 9, customer_id: 3 })).toBe(
      "/quotes?tab=product&customer_id=3&inquiry_id=9",
    );
  });

  it("关联订单 = /orders?id=", () => {
    expect(orderDetailHref(42)).toBe("/orders?id=42");
  });
});

describe("resolveInquiryStage：后端真值优先，关后重开按 status 退化", () => {
  it("合法 stage 且不是重置状态 ⇒ 用后端真值", () => {
    expect(resolveInquiryStage("order", "quoted")).toMatchObject({
      stage: "order",
      label: "订单",
      source: "backend",
    });
  });

  it("status=closed 一律展示关闭（即使 stage 还没回填）", () => {
    expect(resolveInquiryStage("quotation", "closed")).toMatchObject({
      stage: "closed",
      label: "关闭",
      source: "derived",
    });
  });

  it("重开后的陈旧 stage=closed ⇒ 按 status 退化（否则永远停在关闭）", () => {
    expect(resolveInquiryStage("closed", "quoted")).toMatchObject({
      stage: "quotation",
      source: "derived",
    });
    expect(resolveInquiryStage("closed", "unquoted")).toMatchObject({
      stage: "inquiry",
    });
  });

  it("历史行 stage 缺失/非法 ⇒ 退化", () => {
    expect(resolveInquiryStage(null, "unquoted").stage).toBe("inquiry");
    expect(resolveInquiryStage("stage_v2", "quoted").stage).toBe("quotation");
  });
});

describe("状态机（与 ws_crm_ext.py:_INQUIRY_NEXT 同构）", () => {
  it("非终态可关闭；closed 不可再关闭", () => {
    expect(canCloseInquiry("unquoted")).toBe(true);
    expect(canCloseInquiry("quoted")).toBe(true);
    expect(canCloseInquiry("closed")).toBe(false);
  });

  it("重开：有报价回已报价，无报价回待报价", () => {
    expect(reopenStatus("closed", true)).toBe("quoted");
    expect(reopenStatus("closed", false)).toBe("unquoted");
    expect(reopenStatus("quoted", true)).toBeNull();
  });

  it("状态文案", () => {
    expect(inquiryStatusLabel("unquoted")).toBe("待报价");
    expect(inquiryStatusLabel("quoted")).toBe("已报价");
  });
});

describe("阶段时间线", () => {
  const logs: InquiryStageLog[] = [
    {
      id: 1,
      from_stage: "inquiry",
      to_stage: "quotation",
      source_event: "quote_created",
      actor_id: "1",
      note: null,
      created_at: "2026-10-17T02:30:00Z",
    },
    {
      id: 2,
      from_stage: "quotation",
      to_stage: "closed",
      source_event: "inquiry_closed",
      actor_id: "2",
      note: "客户不要了",
      created_at: "2026-10-18T05:00:00Z",
    },
  ];

  it("from/to/事件/操作人/备注都映射成中文", () => {
    const entries = stageTimeline(logs);
    expect(entries[0]).toMatchObject({
      fromLabel: "询盘",
      toLabel: "报价",
      sourceLabel: "创建报价单",
      actorId: "1",
    });
    expect(entries[1]).toMatchObject({
      fromLabel: "报价",
      toLabel: "关闭",
      sourceLabel: "手动关闭询盘",
      note: "客户不要了",
    });
  });

  it("未知事件原样透出（不吞信息）", () => {
    const entries = stageTimeline([
      { ...logs[0]!, source_event: "future_event" },
    ]);
    expect(entries[0]?.sourceLabel).toBe("future_event");
  });
});

describe("展示格式化", () => {
  const item: InquiryItem = {
    product_name_raw: "牛栏网 2.5mm × 1.5m",
    spec_text: "2.5mm 热镀锌",
    quantity: 1000,
    quantity_unit: "m",
    application: "牧场围栏",
  };

  it("渠道文案（未知值原样展示）", () => {
    expect(channelLabel("alibaba")).toBe(CHANNEL_LABEL.alibaba);
    expect(channelLabel("carrier_pigeon")).toBe("carrier_pigeon");
    expect(channelLabel(null)).toBe("—");
  });

  it("日期按 ISO 截取（不换算时区，避免 SSR/客户端漂移）", () => {
    expect(formatInquiryDate("2026-10-17T02:30:00Z")).toBe("2026-10-17");
    expect(formatInquiryDateTime("2026-10-17T02:30:00Z")).toBe(
      "2026-10-17 02:30",
    );
    expect(formatInquiryDate(null)).toBe("—");
    expect(formatInquiryDate("not-a-date")).toBe("—");
  });

  it("金额两位小数 + 币种；缺值显示 —", () => {
    expect(formatInquiryMoney(3612.36, "USD")).toBe("USD 3,612.36");
    expect(formatInquiryMoney(null, "USD")).toBe("—");
    expect(formatInquiryMoney(0, null)).toBe("0.00");
  });

  it("产品行视图 + 摘要（items 优先）", () => {
    const views = inquiryItemViews({ items: [item] });
    expect(views[0]).toMatchObject({
      name: "牛栏网 2.5mm × 1.5m",
      spec: "2.5mm 热镀锌",
      quantity: 1000,
      quantityUnit: "m",
    });
    expect(inquiryProductSummary(views)).toBe("牛栏网 2.5mm × 1.5m");

    const many = inquiryItemViews({
      items: [
        item,
        { product_name_raw: "勾花网" },
        { product_name_raw: "石笼网" },
      ],
    });
    expect(inquiryProductSummary(many)).toBe(
      "牛栏网 2.5mm × 1.5m、勾花网 等 3 个产品",
    );
  });

  it("没有产品行时摘要显示占位，不抛错", () => {
    expect(inquiryProductSummary(inquiryItemViews({ items: [] }))).toBe(
      "未填写产品",
    );
  });
});

const original = (overrides: Partial<InquiryBase> = {}): InquiryBase => ({
  id: 1,
  customer_id: 1,
  inquiry_no: "INQ-202610-0001",
  lead_id: null,
  channel: "alibaba",
  category_id: null,
  product_name_raw: "牛栏网 2.5mm",
  quantity: 1000,
  quantity_unit: "m",
  application: "牧场围栏",
  items: [
    {
      product_name_raw: "牛栏网 2.5mm",
      spec_text: "2.5mm 热镀锌",
      quantity: 1000,
      quantity_unit: "m",
      application: "牧场围栏",
    },
  ],
  status: "quoted",
  stage: "quotation",
  stage_updated_at: null,
  created_at: "2026-10-17T02:30:00Z",
  ...overrides,
});

describe("buildInquiryUpdatePayload：只发改过的字段", () => {
  it("无改动 ⇒ 空 patch", () => {
    const detail = original();
    const plan = buildInquiryUpdatePayload(detail, draftFromDetail(detail));
    expect(plan.error).toBeNull();
    expect(plan.patch).toEqual({});
  });

  it("渠道变更 ⇒ 只发 channel", () => {
    const detail = original();
    const draft = { ...draftFromDetail(detail), channel: "expo" };
    expect(buildInquiryUpdatePayload(detail, draft).patch).toEqual({
      channel: "expo",
    });
  });

  it("渠道清空被前端拦截（内核 validate_enum 不收空值）", () => {
    const detail = original();
    const draft = { ...draftFromDetail(detail), channel: "" };
    const plan = buildInquiryUpdatePayload(detail, draft);
    expect(plan.patch).toEqual({});
    expect(plan.error).toContain("渠道不能清空");
  });

  it("产品行改数量 ⇒ 发 items（第一行由后端同步旧标量字段）", () => {
    const detail = original();
    const draft = draftFromDetail(detail);
    const row = draft.items[0]!;
    draft.items = [{ ...row, quantity: "1200" }];
    const plan = buildInquiryUpdatePayload(detail, draft);
    expect(plan.error).toBeNull();
    expect(plan.patch.items).toEqual([
      {
        product_name_raw: "牛栏网 2.5mm",
        spec_text: "2.5mm 热镀锌",
        quantity: 1200,
        quantity_unit: "m",
        application: "牧场围栏",
      },
    ]);
    // 前端只发 items，不重复发标量字段（否则两处口径要各自维护）
    expect(plan.patch).not.toHaveProperty("product_name_raw");
    expect(plan.patch).not.toHaveProperty("quantity");
  });

  it("数量填字母 ⇒ 返回可读错误，不发请求", () => {
    const detail = original();
    const draft = draftFromDetail(detail);
    draft.items = [{ ...draft.items[0]!, quantity: "abc" }];
    const plan = buildInquiryUpdatePayload(detail, draft);
    expect(plan.patch).toEqual({});
    expect(plan.error).toBe("第 1 行产品的数量请填数字");
  });

  it("全空行被丢弃（不发垃圾行）；新增行可正常提交", () => {
    const detail = original();
    const draft = {
      ...draftFromDetail(detail),
      items: [...draftFromDetail(detail).items, emptyInquiryItemDraftRow()],
    };
    expect(buildInquiryUpdatePayload(detail, draft).patch).toEqual({});

    const added = [
      ...draftFromDetail(detail).items,
      {
        ...emptyInquiryItemDraftRow(),
        product_name_raw: "石笼网",
        quantity: "10",
      },
    ];
    const plan = buildInquiryUpdatePayload(detail, { ...draft, items: added });
    expect(plan.patch.items).toHaveLength(2);
  });

  it("itemDraftRows：后端 items → 表单行（数量转字符串）", () => {
    const rows = itemDraftRows(original().items);
    expect(rows[0]).toMatchObject({
      product_name_raw: "牛栏网 2.5mm",
      quantity: "1000",
      quantity_unit: "m",
    });
  });
});
