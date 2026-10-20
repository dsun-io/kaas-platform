// @vitest-environment node
/**
 * 应收台账 MSW 契约（C36 下期 #7 · `GET /api/v1/receivables`）
 *
 * 形状真源：`backend/worker/src/main.py:4090 list_receivables`
 *   - 参数**只有** `status`（unpaid|partial|paid，非法 422 `bad_receivable_status`）+ `page`/`page_size`
 *   - 返回 `{items,total,page,page_size}`；行 = 共享 12 键 + join `order_no/customer_name`
 * ⚠️ 特意断言"行里没有 due_date"：后端不返回到期日 ⇒ mock 也不能造，
 *    否则页面会在 mock 下"看起来能判逾期"、生产却不能。
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

const RECEIVABLE_KEYS = [
  "id",
  "order_id",
  "currency",
  "total_amount",
  "fx_rate",
  "fx_rate_date",
  "base_currency",
  "base_amount",
  "received_amount",
  "exchange_gain_loss",
  "status",
  "created_at",
  "order_no",
  "customer_name",
].sort();

describe("GET /receivables", () => {
  it("默认第 1 页：{items,total,page,page_size}；行 = 12 键 + order_no/customer_name", async () => {
    const res = await get<{
      items: Json[];
      total: number;
      page: number;
      page_size: number;
    }>("/receivables");

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.page_size).toBe(20);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(RECEIVABLE_KEYS);
      // 后端不返回到期日 ⇒ mock 也不许有（页面据此说明"逾期取决于收款计划"）
      expect(item).not.toHaveProperty("due_date");
    }
  });

  it("status 过滤只返回该状态；非法 status ⇒ 422 bad_receivable_status", async () => {
    const unpaid = await get<{ items: Json[]; total: number }>(
      "/receivables?status=unpaid",
    );
    expect(unpaid.status).toBe(200);
    expect(unpaid.body.items.length).toBeGreaterThan(0);
    expect(unpaid.body.items.every((item) => item.status === "unpaid")).toBe(true);

    const bad = await get<{ detail: { error: string } }>("/receivables?status=oops");
    expect(bad.status).toBe(422);
    expect(bad.body.detail.error).toBe("bad_receivable_status");
  });

  it("真分页：page_size 生效、total 不受分页影响", async () => {
    const first = await get<{ items: Json[]; total: number; page: number }>(
      "/receivables?page=1&page_size=2",
    );
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    const total = first.body.total;
    expect(total).toBeGreaterThan(2);

    const second = await get<{ items: Json[]; total: number; page: number }>(
      "/receivables?page=2&page_size=2",
    );
    expect(second.body.page).toBe(2);
    expect(second.body.total).toBe(total);
    expect(second.body.items[0]?.id).not.toBe(first.body.items[0]?.id);
  });
});
