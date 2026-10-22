// @vitest-environment node
/**
 * 审批 / 通知 / 指定审批人 / dashboard 漏斗 MSW 契约（M2-C + M3）
 *
 * 形状真源：
 *  - `backend/worker/src/ws_approvals.py`（_request_dict / _notification_dict /
 *    unread-count 的 `{unread}` / read-all 的 `{marked}` / approvers 的 fallback）；
 *  - `backend/worker/src/main.py:2107-2210`（dashboard_funnel：时间窗询盘 cohort、
 *    直接下单单列、权重 1/2/10 = composite_score）。
 *
 * 覆盖点：
 *  1. 变更申请必须走「先留痕、批准后才应用」——提交后订单金额不变，批准后才变；
 *  2. 拒绝必须带理由（422 DECISION_REASON_REQUIRED，与内核逐字同码）；
 *  3. 通知逐人落行：提交/批准都会给相关人员新增未读；
 *  4. 指定审批人整表替换，只接受本团队成员。
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

async function call(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function putInit(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** 建一张已确认订单（审批类端点只对非 pending 订单开放）。 */
async function createConfirmedOrder(): Promise<number> {
  const created = await call(
    "/orders",
    jsonInit({
      customer_id: 1,
      currency: "USD",
      items: [
        {
          product_name: "不锈钢网",
          qty: 2,
          unit_price: 10,
          currency: "USD",
          line_amount: 20,
        },
      ],
    }),
  );
  expect(created.status).toBe(201);
  const id = Number((created.body as Json).id);
  const confirmed = await call(
    `/orders/${id}/status`,
    jsonInit({ status: "confirmed" }),
  );
  expect(confirmed.status).toBe(200);
  return id;
}

describe("GET /api/v1/dashboard/funnel（M3）", () => {
  it("返回四阶段漏斗 + 分渠道 + 直接下单 + composite_score（权重 1/2/10）", async () => {
    const { status, body } = await call("/dashboard/funnel?range=30d");
    expect(status).toBe(200);
    const data = body as Json;
    expect(data.range).toBe("30d");
    expect(typeof data.since).toBe("string");
    const funnel = data.funnel as Json;
    const stages = funnel.stages as Array<Json>;
    expect(stages.map((s) => s.name)).toEqual([
      "inquiry",
      "quoted",
      "ordered",
      "completed",
    ]);
    const rates = funnel.conversion_rates as Json;
    expect(Object.keys(rates).sort()).toEqual([
      "inquiry_to_completed",
      "inquiry_to_quote",
      "order_to_completed",
      "quote_to_order",
    ]);
    const channels = data.channels as Array<Json>;
    expect(Array.isArray(channels)).toBe(true);
    // 综合分 = 询盘×1 + 报价×2 + 订单×10（D-6）
    const expected =
      Number(stages[0]!.count) * 1 +
      Number(stages[1]!.count) * 2 +
      Number(stages[2]!.count) * 10;
    expect(funnel.composite_score).toBe(expected);
    expect(data.direct_orders).toMatchObject({
      count: expect.any(Number),
      amount: expect.any(Number),
    });
    expect(data.deprecated_summary).toBe(false);
  });
});

describe("通知（逐人落行）", () => {
  it("种子 1 条未读；标已读后角标归零；read-all 返回清掉的条数", async () => {
    const before = await call("/notifications/unread-count");
    expect(before.body).toEqual({ unread: 1 });

    const list = await call("/notifications");
    expect(list.status).toBe(200);
    const payload = list.body as { items: Array<Json>; total: number };
    expect(payload.total).toBe(2);
    expect(payload.items[0]).toMatchObject({
      id: expect.any(Number),
      title: expect.any(String),
      read_at: null,
    });

    const read = await call("/notifications/1/read", { method: "POST" });
    expect(read.status).toBe(200);
    expect((read.body as Json).read_at).not.toBeNull();
    const after = await call("/notifications/unread-count");
    expect(after.body).toEqual({ unread: 0 });

    // 再塞一条未读后 read-all 才有的清
    const orderId = await createConfirmedOrder();
    await call(
      `/orders/${orderId}/item-change-requests`,
      jsonInit({
        items: [{ product_name: "B", qty: 1, unit_price: 5 }],
        reason: "改量",
      }),
    );
    const all = await call("/notifications/read-all", { method: "POST" });
    expect(all.status).toBe(200);
    expect((all.body as Json).marked).toBe(1);
  });
});

describe("审批中心 / 变更申请（先留痕、批准才生效）", () => {
  it("非法 view → 422 INVALID_VIEW；空列表形状 {items,total,page,page_size}", async () => {
    const bad = await call("/approvals?view=nope");
    expect(bad.status).toBe(422);
    expect((bad.body as Json).detail).toMatchObject({ code: "INVALID_VIEW" });

    const ok = await call("/approvals?view=pending");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
    });
  });

  it("提交变更申请不改订单；批准后才整批替换并重算金额", async () => {
    const orderId = await createConfirmedOrder();
    const created = await call(
      `/orders/${orderId}/item-change-requests`,
      jsonInit({
        items: [
          {
            product_name: "不锈钢网",
            qty: 3,
            unit_price: 10,
            currency: "USD",
            line_amount: 30,
          },
        ],
        reason: "客户加量",
      }),
    );
    expect(created.status).toBe(201);
    const record = created.body as Json;
    expect(record).toMatchObject({
      order_id: orderId,
      status: "pending",
      reason: "客户加量",
    });
    expect((record.notified_approvers as number[]).length).toBeGreaterThan(0);

    // 提交后订单总额不变（30 → 仍是 20）
    const before = await call(`/orders/${orderId}`);
    expect(Number((before.body as Json).total_amount)).toBe(20);

    const history = await call(`/orders/${orderId}/item-change-requests`);
    expect(history.body).toMatchObject({ total: 1 });

    const approved = await call(
      `/orders/${orderId}/item-change-requests/${Number(record.id)}/approve`,
      jsonInit({}),
    );
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      applied: true,
      status: "approved",
      new_total_amount: 30,
    });

    const after = await call(`/orders/${orderId}`);
    expect(Number((after.body as Json).total_amount)).toBe(30);
  });

  it("拒绝必须带理由 → 422 DECISION_REASON_REQUIRED；带理由则不应用明细", async () => {
    const orderId = await createConfirmedOrder();
    const created = await call(
      `/orders/${orderId}/item-change-requests`,
      jsonInit({ items: [{ product_name: "B", qty: 1, unit_price: 5 }] }),
    );
    const rid = Number((created.body as Json).id);

    const rejectedEmpty = await call(
      `/orders/${orderId}/item-change-requests/${rid}/reject`,
      jsonInit({}),
    );
    expect(rejectedEmpty.status).toBe(422);
    expect((rejectedEmpty.body as Json).detail).toMatchObject({
      code: "DECISION_REASON_REQUIRED",
    });

    const rejected = await call(
      `/orders/${orderId}/item-change-requests/${rid}/reject`,
      jsonInit({ reason: "价格没谈拢" }),
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: "rejected", applied: false });
    const after = await call(`/orders/${orderId}`);
    expect(Number((after.body as Json).total_amount)).toBe(20);
  });
});

describe("指定审批人（整表替换）", () => {
  it("空名单 fallback=team_admins；PUT 本团队成员生效；非成员 → 422", async () => {
    const empty = await call("/team/approvers");
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ items: [], fallback: "team_admins" });

    const saved = await call("/team/approvers", putInit({ user_ids: [2] }));
    expect(saved.status).toBe(200);
    const items = (saved.body as { items: Array<Json> }).items;
    expect(items.map((i) => i.user_id)).toEqual([2]);

    const foreign = await call(
      "/team/approvers",
      putInit({ user_ids: [9999] }),
    );
    expect(foreign.status).toBe(422);
    expect((foreign.body as Json).detail).toMatchObject({
      code: "APPROVER_NOT_IN_TEAM",
    });
  });
});
