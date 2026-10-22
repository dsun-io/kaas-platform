// @vitest-environment node
/**
 * 询盘工位 MSW 契约（设计 §8 / §9.1 · task-2）
 *
 * 形状真源：`backend/worker/src/ws_crm_ext.py`
 *   · 列表 :303-399 —— 参数 status/customer_id/stage/channel/date_from/date_to/q，
 *     返回 `{items,total}`；行 = row_to_inquiry + company_name + quote_count +
 *     order_count + latest_quote_at。**没有 page/page_size**（内核不分页）。
 *   · 详情 :402-479 —— row_to_inquiry + company_name + quotes[]（row_to_quote +
 *     order_count，created_at 正序）+ orders[]（row_to_order）+ stage_log[]
 *     + counts{quotes,orders,open_orders}。
 *
 * ⚠️ 特意断言「列表/详情没有 page、详情 quote 没有 quote_no_editable」：
 *    后端没有的键，mock 也不许造，否则页面会写出"mock 能看、生产 undefined"的字段。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

import { handlers, resetMockData } from "../handlers";

const server = setupServer(...handlers);
const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;

beforeAll(() => {
  Object.defineProperty(globalThis, "location", {
    value: { href: `${ORIGIN}/` },
    configurable: true,
  });
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => server.close());
beforeEach(() => resetMockData());

type Json = Record<string, unknown>;

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function patch<T>(
  path: string,
  body: Json,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface ListBody {
  items: Json[];
  total: number;
}

const ROW_KEYS = [
  "id",
  "customer_id",
  "inquiry_no",
  "lead_id",
  "channel",
  "category_id",
  "product_name_raw",
  "quantity",
  "quantity_unit",
  "application",
  "items",
  "status",
  "stage",
  "stage_updated_at",
  "created_at",
  "company_name",
  "quote_count",
  "order_count",
  "latest_quote_at",
].sort();

describe("GET /inquiries（列表）", () => {
  it("{items,total}：行 = row_to_inquiry + company_name + 三个聚合列，无分页键", async () => {
    const res = await get<ListBody>("/inquiries");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(res.body.items.length);
    expect(res.body.items.length).toBeGreaterThan(0);
    // 内核没有分页参数/响应字段
    expect(res.body).not.toHaveProperty("page");
    expect(res.body).not.toHaveProperty("page_size");
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(ROW_KEYS);
      // items 恒为数组（后端把历史旧标量字段合成一行）
      expect(Array.isArray(item.items)).toBe(true);
      expect(typeof item.quote_count).toBe("number");
      expect(typeof item.order_count).toBe("number");
    }
  });

  it("聚合真实：客户 1 的询盘有一条种子报价 ⇒ quote_count≥1、latest_quote_at 非空", async () => {
    const res = await get<ListBody>("/inquiries");
    // 后端 ORDER BY customer_id, created_at DESC ⇒ 客户 1 排在最前
    const first = res.body.items[0]!;
    expect(first.customer_id).toBe(1);
    expect(first.quote_count).toBeGreaterThanOrEqual(1);
    expect(first.latest_quote_at).toBeTruthy();
    // 没有报价的客户 latest_quote_at 必须是 null（不伪造时间）
    const withoutQuote = res.body.items.find((item) => item.quote_count === 0);
    expect(withoutQuote?.latest_quote_at ?? null).toBeNull();
  });

  it("筛选：customer_id / stage / channel / q / 时间范围都生效", async () => {
    const byCustomer = await get<ListBody>("/inquiries?customer_id=1");
    expect(byCustomer.body.items).toHaveLength(1);
    expect(byCustomer.body.items[0]?.customer_id).toBe(1);

    const byStage = await get<ListBody>("/inquiries?stage=quotation");
    expect(byStage.body.items.every((item) => item.stage === "quotation")).toBe(
      true,
    );
    const stageMiss = await get<ListBody>("/inquiries?stage=order");
    expect(stageMiss.body).toEqual({ items: [], total: 0 });

    const byChannel = await get<ListBody>("/inquiries?channel=alibaba");
    expect(byChannel.body.items.length).toBeGreaterThan(0);
    const channelMiss = await get<ListBody>("/inquiries?channel=email");
    expect(channelMiss.body.total).toBe(0);

    const byKeyword = await get<ListBody>("/inquiries?q=牛栏网");
    expect(byKeyword.body.items.length).toBeGreaterThan(0);
    const keywordMiss = await get<ListBody>("/inquiries?q=不存在的产品");
    expect(keywordMiss.body.total).toBe(0);

    // 时间范围按 created_at::date 比较：未来/远古都为空
    const future = await get<ListBody>("/inquiries?date_from=2099-01-01");
    expect(future.body.total).toBe(0);
    const ancient = await get<ListBody>("/inquiries?date_to=2000-01-01");
    expect(ancient.body.total).toBe(0);
  });

  it("非法枚举/日期 ⇒ 与后端同码 422（INVALID_ENUM / INVALID_DATE）", async () => {
    const stage = await get<{ detail: Json }>("/inquiries?stage=stage_v2");
    expect(stage.status).toBe(422);
    expect(stage.body.detail.code).toBe("INVALID_ENUM");
    expect(stage.body.detail.field).toBe("stage");
    expect(Array.isArray(stage.body.detail.allowed)).toBe(true);

    const channel = await get<{ detail: Json }>("/inquiries?channel=quote");
    expect(channel.status).toBe(422);
    expect(channel.body.detail.code).toBe("INVALID_ENUM");
    expect(channel.body.detail.field).toBe("channel");

    const status = await get<{ detail: Json }>("/inquiries?status=oops");
    expect(status.status).toBe(422);
    expect(status.body.detail.code).toBe("INVALID_ENUM");

    const date = await get<{ detail: Json }>("/inquiries?date_from=2026-13-01");
    expect(date.status).toBe(422);
    expect(date.body.detail.code).toBe("INVALID_DATE");
    expect(date.body.detail.field).toBe("date_from");
  });
});

describe("GET /inquiries/{id}（详情）", () => {
  async function firstInquiryId(): Promise<number> {
    const list = await get<ListBody>("/inquiries");
    return Number(list.body.items[0]!.id);
  }

  it("详情 = row_to_inquiry + company_name + quotes/orders/stage_log/counts", async () => {
    const id = await firstInquiryId();
    const res = await get<Json>(`/inquiries/${id}`);

    expect(res.status).toBe(200);
    for (const key of [
      "quotes",
      "orders",
      "stage_log",
      "counts",
      "company_name",
    ]) {
      expect(res.body).toHaveProperty(key);
    }
    const quotes = res.body.quotes as Json[];
    const orders = res.body.orders as Json[];
    const stageLog = res.body.stage_log as Json[];
    const counts = res.body.counts as Json;

    expect(quotes.length).toBeGreaterThan(0);
    // 报价行 = row_to_quote + order_count；不额外造 quote_no_editable
    for (const quote of quotes) {
      expect(quote).toHaveProperty("quote_no");
      expect(quote).toHaveProperty("item_count");
      expect(quote).toHaveProperty("order_count");
      expect(quote).not.toHaveProperty("quote_no_editable");
      expect(typeof quote.item_count).toBe("number");
    }
    // 报价历史按 created_at 正序（改价轨迹）
    const createdAts = quotes.map((quote) => String(quote.created_at));
    expect([...createdAts].sort()).toEqual(createdAts);

    for (const order of orders) {
      expect(order).toHaveProperty("order_no");
      expect(order).toHaveProperty("quote_id");
      expect(order).toHaveProperty("inquiry_id");
    }

    // counts 与数组长度一致（前端直接展示这三个数）
    expect(counts.quotes).toBe(quotes.length);
    expect(counts.orders).toBe(orders.length);
    expect(counts.open_orders).toBeLessThanOrEqual(orders.length);

    // 阶段流水字段（ws_crm_ext.py:466-470）
    expect(stageLog.length).toBeGreaterThan(0);
    for (const log of stageLog) {
      for (const key of [
        "id",
        "from_stage",
        "to_stage",
        "source_event",
        "actor_id",
        "note",
        "created_at",
      ]) {
        expect(log).toHaveProperty(key);
      }
    }
  });

  it("不存在的询盘 ⇒ 404 INQUIRY_NOT_FOUND", async () => {
    const res = await get<{ detail: Json }>("/inquiries/999999");
    expect(res.status).toBe(404);
    expect(res.body.detail.code).toBe("INQUIRY_NOT_FOUND");
  });

  it("PATCH 真的写回 store：改渠道后详情/列表都能读到", async () => {
    const id = await firstInquiryId();
    const res = await patch<Json>(`/inquiries/${id}`, { channel: "email" });
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("email");

    const detail = await get<Json>(`/inquiries/${id}`);
    expect(detail.body.channel).toBe("email");
  });

  it("PATCH 关闭 ⇒ status=closed 且写一条 stage=closed 的阶段流水", async () => {
    const id = await firstInquiryId();
    const before = await get<Json>(`/inquiries/${id}`);
    const beforeLogs = (before.body.stage_log as Json[]).length;

    const res = await patch<Json>(`/inquiries/${id}`, { status: "closed" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("closed");

    const after = await get<Json>(`/inquiries/${id}`);
    expect(after.body.status).toBe("closed");
    expect(after.body.stage).toBe("closed");
    const logs = after.body.stage_log as Json[];
    expect(logs).toHaveLength(beforeLogs + 1);
    expect(logs[logs.length - 1]?.to_stage).toBe("closed");
    expect(logs[logs.length - 1]?.source_event).toBe("inquiry_closed");
  });
});
